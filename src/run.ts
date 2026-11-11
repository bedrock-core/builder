import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { validateConfig } from './config.ts';
import { isStagingExcluded, isStagingInput, stagingExclusions, stagingInputs } from './staging.ts';
import { planBuild, type PlannedPlugin } from './plan.ts';
import { resolveProject } from './project.ts';
import { runNodeFilter, publishNodeData } from './regolith.ts';
import { builtinPlugins } from './builtins.ts';
import { loadPlugin, executePlugin } from './plugins.ts';
import { nativePluginContexts, sharedPackWrites } from './plugin-routing.ts';
import type { StageName } from './config.ts';
import type { BuildPlugin, BundleExtension, CacheOptions } from '@bedrock-core/builder-plugin';
import { inspectPacks, type PackInfo } from './packs.ts';
import { describePack, resolvePackGraph } from '@bedrock-core/builder-plugin';
import { resolveManifest, resolveProjectManifests, hasApiExports, type JsonObject } from '@bedrock-core/builder-manifest';
import { finalizePackManifests, prepareAddonArtwork, validatePackManifests } from './manifest.ts';
import { resolveExportPaths, resolveApiPackagePath, withExportPaths } from './export.ts';
import { createHash } from 'node:crypto';
import { createFileCache, trackLocations } from './file-cache.ts';
import type { Artifact, BuildContext, BuildOptions, BuildResult } from './contract.d.ts';
import { validatePackContent, type ContentValidationResult } from '@bedrock-core/builder-validation';
export type {
  Artifact,
  BuildContext,
  BuildOptions,
  BuildResult,
  BuildStep,
  BuildStepResult,
  BuildPlugin,
} from './contract.d.ts';

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return (
    relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
};

const check = (signal?: AbortSignal) => signal?.throwIfAborted();

/**
 * Build an isolated staged project and publish all packs after successful validation.
 * Plugins execute as trusted Node code. Build failures retain the previous export.
 * @returns Export destinations, validation coverage and execution records without temporary paths.
 */
export async function runBuild({
  configPath = 'config.json',
  profile = 'default',
  stages = {},
  signal,
  logger = console,
  validateArtifacts,
}: BuildOptions): Promise<BuildResult> {
  const file = await realpath(configPath);
  const project = path.dirname(file);
  const config = validateConfig(JSON.parse(await readFile(file, 'utf8')));
  const plan = planBuild(config, profile);
  const metadataInputs = new Set<string>();
  const metadata = await resolveProject(config, project, file => metadataInputs.add(file));
  const implementations = new Map<string, BuildPlugin>();

  async function implementation(stage: StageName): Promise<BuildPlugin> {
    if (!implementations.has(stage)) {
      const replacement = stages[stage];
      const plugin = replacement && typeof replacement !== 'function'
        ? replacement
        : await loadPlugin(import.meta.resolve(builtinPlugins[stage]), stage);

      implementations.set(stage, typeof replacement === 'function' ? { ...plugin, run: replacement } : plugin);
    }

    return implementations.get(stage)!;
  }

  const exportConfig = config.bedrockCore.profiles[profile]?.export;

  if (!exportConfig) {
    throw new Error('Profile needs export destinations for its packs to execute a build');
  }

  const outputPaths = Object.freeze(resolveExportPaths(project, config.packs, exportConfig));
  const packageFile = path.join(project, 'package.json');
  const packageMetadata: unknown = await exists(packageFile) ? JSON.parse(await readFile(packageFile, 'utf8')) : undefined;
  const hasPublicApi = hasApiExports(packageMetadata);
  const apiSelection = config.bedrockCore.profiles[profile]?.api;
  const apiOutput = hasPublicApi && apiSelection !== false
    ? resolveApiPackagePath(project, config.packs, outputPaths, apiSelection ?? 'dist/api')
    : undefined;
  const outputs = Object.values(config.bedrockCore.profiles).flatMap((settings) => {
    if (!settings.export) {
      return [];
    }

    try {
      const paths = resolveExportPaths(project, config.packs, settings.export);

      return [...Object.values(paths), ...(hasPublicApi && settings.api !== false ? [resolveApiPackagePath(project, config.packs, paths, settings.api ?? 'dist/api')] : [])];
    } catch {
      return [];
    }
  });

  const packs = Object.fromEntries(
    Object.entries(config.packs).map(([id, relative]) => [id, path.resolve(project, relative!)]),
  );

  for (const source of Object.values(packs)) {
    if (!inside(project, source)) {
      throw new Error('Pack sources must be directories inside the project');
    }

    if (!(await stat(source)).isDirectory()) {
      throw new Error(`Pack is not a directory: ${source}`);
    }
  }

  for (const step of plan) {
    if (
      step.kind === 'stage'
      && !['prepare', 'validate', 'export'].includes(step.stage)
      && step.mode === 'always'
    ) {
      await implementation(step.stage as StageName);
    }
  }

  check(signal);
  // Loading is deferred until execution; resolving paths cannot execute module code.
  const require = createRequire(file);
  const modules = new Map<string, string>();

  for (const step of plan.filter(step => step.kind === 'plugin')) {
    if (step.script !== undefined) {
      continue;
    }

    const local = step.module.startsWith('.') || path.isAbsolute(step.module);
    const modulePath = local ? path.resolve(project, step.module) : require.resolve(step.module);

    if (local && !inside(project, await realpath(modulePath))) {
      throw new Error(`Plugin module must be inside the project: ${step.module}`);
    }

    modules.set(step.module, modulePath);
  }

  const exclusions = stagingExclusions(project, config, file);
  const ignored = new Set(['.git', 'node_modules', '.bedrock-core']);
  const normalized = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
  const isOutput = (file: string) => outputs.some(output =>
    path.relative(output, file) === '' || normalized(file).startsWith(`${normalized(output)}.builder-`),
  );

  const sources = await stagingInputs(project, config, profile, file, outputs, signal);

  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are unsupported in staged sources: ${source}`);
      }

      if (entry.isDirectory()) {
        await inspect(source);
      }
    }
  }

  return withExportPaths(outputPaths, async (publish) => {
    let workspace: string | undefined;
    const dependencies = new Set([file, ...sources, ...metadataInputs, ...modules.values(), ...(hasPublicApi ? [packageFile] : [])]);
    const artifacts = new Map<string, Artifact>();
    const artifactFinalizers = new Map<string, (artifact: Artifact) => void | Promise<void>>();
    const generatedImports = new Map<string, string>();
    const packImports = new Map<string, Map<string, string>>();
    const exportExclusions = new Set<string>();
    const inputDirectories = new Set<string>();
    const bundleExtensions = new Map<string, BundleExtension>();
    const stageResults: BuildResult['stages'] = [];
    let publishedPacks: PackInfo[] = [];
    let validation: ContentValidationResult;

    try {
      workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'bedrock-core-build-')));
      const staged = path.join(workspace, 'project');

      await cp(project, staged, {
        recursive: true,
        filter: source =>
          isStagingInput(source, sources) && !isOutput(source) && !ignored.has(path.basename(source)) && !isStagingExcluded(source, exclusions),
      });
      const generated = path.join(workspace, 'generated');

      await mkdir(generated);

      if (await exists(path.join(project, 'node_modules'))) {
        await symlink(path.join(project, 'node_modules'), path.join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      }

      const stagedPacks = Object.fromEntries(
        Object.entries(packs).map(([id, source]) => [
          id,
          path.join(staged, path.relative(project, source)),
        ]),
      );
      const withDestinations = (packs: readonly PackInfo[]): readonly PackInfo[] => Object.freeze(packs.map(pack => Object.freeze({ ...pack, outputPath: outputPaths[pack.id]! })));

      async function currentPacks(): Promise<readonly PackInfo[]> {
        if (Object.keys(stagedPacks).every(id => artifacts.has(`manifest:${id}`))
          || config.bedrockCore.profiles[profile]?.stages?.manifest === false) {
          return withDestinations(await inspectPacks(stagedPacks));
        }

        const selection = config.bedrockCore.profiles[profile]?.stages?.manifest;
        const requested = typeof selection === 'object' ? selection.manifestPath : undefined;
        const sources = typeof requested === 'string' ? [requested] : Array.isArray(requested) ? requested as string[] : [];
        const manifests: Record<string, JsonObject> = {};

        for (const [id, directory] of Object.entries(stagedPacks)) {
          const source = sources.find(file => path.resolve(staged, path.dirname(file)) === directory);
          const result = await resolveManifest(source ? path.resolve(staged, source) : path.join(directory, 'manifest.json'), { root: staged, signal, validate: false });

          manifests[id] = result.manifest;

          for (const input of result.inputs) {
            dependencies.add(path.join(project, path.relative(staged, input)));
          }
        }

        const resolved = resolveProjectManifests(manifests, metadata, { dependencyRoot: project, registerDependency: input => dependencies.add(input) });

        return withDestinations(resolvePackGraph(Object.entries(stagedPacks).map(([id, directory]) => describePack(id, directory, resolved[id]))));
      }

      let owner = 'prepare';
      const dependencyLocations = new Set<string>();
      const cache = await createFileCache({
        directory: path.join(project, '.bedrock-core/cache/build', createHash('sha256').update(profile).digest('hex')),
        roots: { project: staged, generated, workspace },
        enabled: config.bedrockCore.profiles[profile]?.cache !== false,
        signal,
        scope: () => owner,
        warn: message => logger.warn?.(`@bedrock-core/builder: ${message}`),
        dependency(file, location) {
          let source: string | undefined;

          if (inside(staged, file)) {
            source = path.join(project, path.relative(staged, file));
          } else if (!inside(workspace!, file)) {
            source = file;
          }

          if (source) {
            dependencies.add(source);

            if (location) {
              dependencyLocations.add(source);
            }
          }
        },
      });
      const context: BuildContext = Object.freeze({
        projectRoot: project,
        project: metadata,
        stagedRoot: staged,
        generatedDir: generated,
        cache: config.bedrockCore.profiles[profile]?.cache !== false,
        get generatedImports() {
          return Object.freeze(Object.fromEntries(generatedImports));
        },
        get inputDirectories() {
          return Object.freeze([...inputDirectories]);
        },
        generatedImportsFor(pack: string) {
          if (!Object.hasOwn(stagedPacks, pack)) {
            throw new Error(`Generated imports reference an unknown pack: ${pack}`);
          }

          return Object.freeze(Object.fromEntries([...generatedImports, ...packImports.get(pack) ?? []]));
        },
        get bundleExtensions() {
          return Object.freeze([...bundleExtensions.values()]);
        },
        reuse<T>(id: string, options: CacheOptions<T>) {
          return cache.reuse(id, options);
        },
        registerBundleExtension(extension: BundleExtension) {
          if (!extension || typeof extension.id !== 'string' || !extension.id.trim()
            || typeof extension.version !== 'string' || !extension.version.trim()) {
            throw new Error('Bundle extension needs nonempty id and version');
          }

          if (bundleExtensions.has(extension.id)) {
            throw new Error(`Bundle extension already registered: ${extension.id}`);
          }

          if (extension.packs && (!Array.isArray(extension.packs) || extension.packs.some(id => !Object.hasOwn(stagedPacks, id)))) {
            throw new Error(`Bundle extension references an unknown pack: ${extension.id}`);
          }

          const copy = Object.freeze({
            ...extension,
            ...(extension.packs ? { packs: Object.freeze([...extension.packs]) } : {}),
            ...(extension.moduleNames ? { moduleNames: Object.freeze([...extension.moduleNames]) } : {}),
            ...(extension.inputs ? { inputs: Object.freeze([...extension.inputs]) } : {}),
            ...(extension.plugins ? { plugins: Object.freeze([...extension.plugins]) } : {}),
            ...(extension.resolveFromProject ? { resolveFromProject: Object.freeze([...extension.resolveFromProject]) } : {}),
          });

          bundleExtensions.set(extension.id, copy);
        },
        packs: Object.freeze(stagedPacks),
        allPacks: Object.freeze(stagedPacks),
        inspectPacks: currentPacks,
        outputPaths,
        ...(apiOutput ? { apiOutput } : {}),
        profile,
        logger,
        signal,
        registerDependency(filePath: string) {
          dependencies.add(path.resolve(project, filePath));
        },
        excludeFromExport(filePath: string) {
          const file = path.resolve(staged, filePath);

          if (!Object.values(stagedPacks).some(pack => inside(pack, file))
            || Object.values(stagedPacks).some(pack => pack === file || inside(file, pack))) {
            throw new Error('Export exclusions must stay inside a pack and cannot contain pack roots');
          }

          exportExclusions.add(file);
          inputDirectories.add(file);
        },
        async registerArtifact(id: string, filePath: string, options?: { importAs?: string; pack?: string }) {
          if (typeof id !== 'string' || !id.trim()) {
            throw new Error('Artifact ID must be nonempty');
          }

          const location = await realpath(path.resolve(staged, filePath));

          if (!inside(workspace!, location) || !(await stat(location)).isFile()) {
            throw new Error(`Artifact must be a staged file: ${id}`);
          }

          if (artifacts.has(id)) {
            throw new Error(`Artifact already registered: ${id}`);
          }

          const importAs = options?.importAs;
          const pack = options?.pack;

          if (pack !== undefined && !Object.hasOwn(stagedPacks, pack)) {
            throw new Error(`Artifact references an unknown pack: ${pack}`);
          }

          if (importAs !== undefined) {
            if (typeof importAs !== 'string' || !importAs.trim()) {
              throw new Error(`Artifact import name must be nonempty: ${id}`);
            }

            if (generatedImports.has(importAs)
              || (pack ? packImports.get(pack)?.has(importAs) || generatedImports.has(`${importAs}/${pack}`) : [...packImports.values()].some(imports => imports.has(importAs)))) {
              throw new Error(`Generated import already registered: ${importAs}; owned by ${generatedImports.get(importAs)}`);
            }

            if (pack) {
              const imports = packImports.get(pack) ?? new Map<string, string>();

              imports.set(importAs, id);
              packImports.set(pack, imports);
              generatedImports.set(`${importAs}/${pack}`, id);
            } else {
              generatedImports.set(importAs, id);
            }
          }

          artifacts.set(id, Object.freeze({ id, path: location, owner, ...(importAs ? { importAs } : {}), ...(pack ? { pack } : {}) }));
        },
        finalizeArtifact(id: string, finalize: (artifact: Artifact) => void | Promise<void>) {
          const artifact = artifacts.get(id);

          if (!artifact || artifact.owner !== owner) {
            throw new Error(`Artifact finalization requires an artifact owned by this invocation: ${id}`);
          }

          if (typeof finalize !== 'function' || artifactFinalizers.has(id)) {
            throw new Error(`Artifact needs one finalizer function: ${id}`);
          }

          artifactFinalizers.set(id, finalize);
        },
        artifact(id: string) {
          const artifact = artifacts.get(id);

          if (!artifact) {
            throw new Error(
              `Missing artifact: ${id}; select its producer or register an external input copied into staging`,
            );
          }

          return artifact;
        },
        async inspectPack(id: string) {
          const directory = stagedPacks[id];

          if (!directory) {
            throw new Error(`Pack is not configured: ${id}`);
          }

          return (await currentPacks()).find(pack => pack.id === id)!;
        },
      });

      async function nativeImplementation(step: PlannedPlugin & { module: string }): Promise<BuildPlugin> {
        const module = modules.get(step.module)!;
        const local = step.module.startsWith('.') || path.isAbsolute(step.module);
        const pluginFile = local ? path.join(staged, path.relative(project, module)) : module;
        const url = pathToFileURL(pluginFile);

        url.searchParams.set('build', path.basename(workspace!));

        return loadPlugin(url.href, step.plugin);
      }

      for (const [index, step] of plan.entries()) {
        check(signal);
        owner = step.kind === 'plugin' ? `${step.plugin}:${index}` : step.stage;
        cache.boundary();

        if (step.kind === 'stage' && step.stage === 'generator') {
          for (const producer of plan) {
            let plugin: BuildPlugin;

            if (producer.kind === 'stage') {
              if (['prepare', 'validate', 'export'].includes(producer.stage)) {
                continue;
              }

              plugin = await implementation(producer.stage as StageName);
            } else if (producer.module !== undefined) {
              plugin = await nativeImplementation(producer);
            } else {
              continue;
            }

            if (!plugin.inputDirectories) {
              continue;
            }

            const invocations = producer.kind === 'stage'
              ? [context]
              : nativePluginContexts(context, plugin, producer, plugin.requirements === undefined ? [] : await currentPacks());

            for (const invocation of invocations) {
              for (const directory of await plugin.inputDirectories(invocation, producer.settings ?? {})) {
                if (!Object.values(invocation.packs).some(pack => inside(pack, directory))) {
                  throw new Error('Plugin input directories must be inside selected packs');
                }

                inputDirectories.add(directory);
              }
            }
          }
        }

        if (step.kind === 'plugin' || ['prepare', 'validate', 'export'].includes(owner)) {
          logger.info?.(`@bedrock-core/builder: ${owner}`);
        }

        if (step.kind === 'plugin') {
          if (step.script === undefined) {
            const plugin = await nativeImplementation(step);
            const invocations = nativePluginContexts(context, plugin, step, plugin.requirements === undefined ? [] : await currentPacks());
            const writes = sharedPackWrites(invocations, step.plugin);

            if (!invocations.length) {
              logger.info?.(`@bedrock-core/builder: ${owner} skipped (No packs match the plugin module requirements)`);
            }

            for (const invocation of invocations) {
              check(signal);

              if (invocation.pack) {
                owner = `${step.plugin}:${index}:${invocation.pack.id}`;
                cache.boundary();
                logger.info?.(`@bedrock-core/builder: ${owner}`);
              }

              const before = await writes.snapshot(invocation);
              const outcome = await executePlugin(plugin, invocation, step.settings, step.mode);

              await writes.verify(invocation, before);
              logger.info?.(`@bedrock-core/builder: ${owner} ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
            }

            continue;
          }

          await runNodeFilter(context, step, context);
        } else if (step.stage === 'validate') {
          for (const artifact of artifacts.values()) {
            const current = await realpath(artifact.path);

            if (!inside(workspace, current) || !(await stat(current)).isFile()) {
              throw new Error(`Invalid registered artifact: ${artifact.id}`);
            }
          }

          await validateArtifacts?.(context);

          for (const file of exportExclusions) {
            try {
              await rm(file, { recursive: true, force: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
                throw error;
              }
            }
          }

          await finalizePackManifests(stagedPacks);

          for (const [id, finalize] of artifactFinalizers) {
            check(signal);
            await finalize(artifacts.get(id)!);
            const file = await realpath(artifacts.get(id)!.path);

            if (!inside(workspace, file) || !(await stat(file)).isFile()) {
              throw new Error(`Invalid finalized artifact: ${id}`);
            }
          }

          await validatePackManifests(stagedPacks);
          await inspectPacks(stagedPacks);
          const mode = config.bedrockCore.profiles[profile]?.validation ?? 'warn';

          validation = await validatePackContent({
            packs: await Promise.all(Object.keys(stagedPacks).map(id => context.inspectPack(id))),
            mode,
            signal,
            async reuse(file, inputs, revision, validate) {
              const result = await cache.reuse(path.relative(staged, file).replaceAll('\\', '/'), {
                inputs: [file, ...inputs],
                key: { revision },
                async run() {
                  return { value: await validate() };
                },
              });

              return result.value;
            },
          });
          const checked = validation.files.filter(file => file.schema).length;

          logger.info?.(mode === 'skip'
            ? `@bedrock-core/builder: checked ${validation.files.length} JSON documents for syntax; content schema validation skipped`
            : `@bedrock-core/builder: ${mode === 'warn' ? 'checked' : 'validated'} ${checked} content documents against Mojang schemas ${validation.schemaVersion}; ${validation.files.length - checked} additional JSON documents checked for syntax`);
          const schemaIssues = new Set(validation.files.flatMap(file => file.schemaIssue ? [file.schemaIssue] : []));

          for (const issue of schemaIssues) {
            logger.warn?.(`@bedrock-core/builder: ${issue}`);
          }

          for (const { pack, file, pointer, message } of validation.files.flatMap(result => result.diagnostics)) {
            logger.warn?.(`@bedrock-core/builder: ${pack}/${file}${pointer}: ${message}`);
          }
        } else if (step.stage === 'export') {
          publishedPacks = [...withDestinations(await inspectPacks(stagedPacks))];
          await inspect(staged);
          check(signal);
          const apiPackage = artifacts.get('api:package');

          await publishNodeData(context, () => publish(stagedPacks, signal, apiPackage ? path.dirname(apiPackage.path) : undefined));
        } else if (step.stage !== 'prepare') {
          const plugin = await implementation(step.stage);
          const outcome = await executePlugin(plugin, context, step.settings ?? {}, step.mode);

          if (step.stage === 'manifest') {
            const ui = config.bedrockCore.profiles[profile]?.stages?.['ui-compiler'];

            await prepareAddonArtwork(context, typeof ui === 'object' ? ui : {});
          }

          stageResults.push({ stage: step.stage, ...outcome });
          logger.info?.(`@bedrock-core/builder: ${step.stage} ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
        }
      }

      // Publication has committed; cancellation can skip this optional cache write.
      try {
        await cache.save();
      } catch (error) {
        if (!signal?.aborted) {
          throw error;
        }
      }

      const result = Object.freeze({
        validation: validation!,
        outputPaths,
        ...(artifacts.has('api:package') ? { apiOutput } : {}),
        profile,
        stages: stageResults,
        dependencies: [...dependencies],
        compilations: cache.results,
        artifacts: [...artifacts.values()].map(({ id, owner, importAs, pack }) => ({ id, owner, ...(importAs ? { importAs } : {}), ...(pack ? { pack } : {}) })),
        packs: publishedPacks.map(pack => ({ ...pack, path: outputPaths[pack.id]! })),
      });

      trackLocations(result, dependencyLocations);

      return result;
    } finally {
    // Cleanup removes owned directories and dependency links without following link targets.
      if (workspace) {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }, apiOutput);
}
