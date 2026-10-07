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
import { planBuild } from './plan.ts';
import { detectStage } from './detect.ts';
import { inspectPack, type PackInfo } from './packs.ts';
import { validatePackManifests } from './manifest.ts';
import { resolveExportPaths, withExportPaths } from './export.ts';
import { createHash } from 'node:crypto';
import { createFileCache, attachCache, trackLocations } from './file-cache.ts';
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

/** Run trusted plugins against an isolated staged project and publish only successful packs. */
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
  const implementations = { ...stages };

  async function implementation(stage: string) {
    if (!implementations[stage]) {
      if (stage === 'manifest') {
        implementations.manifest = (await import('./stages/manifest.ts')).run;
      } else if (stage === 'generator') {
        implementations.generator = (await import('./stages/generator.ts')).run;
      } else if (stage === 'guides') {
        implementations.guides = (await import('./stages/guides.ts')).run;
      } else if (stage === 'i18n') {
        implementations.i18n = (await import('./stages/i18n.ts')).run;
      } else if (stage === 'bundler') {
        implementations.bundler = (await import('./stages/bundler.ts')).run;
      } else if (stage === 'ui-compiler') {
        implementations['ui-compiler'] = (await import('./stages/ui-compiler.ts')).run;
      }
    }

    if (typeof implementations[stage] !== 'function') {
      throw new Error(`Stage implementation unavailable: ${stage}`);
    }

    return implementations[stage]!;
  }

  const exportConfig = config.bedrockCore.profiles[profile]?.export;

  if (!exportConfig) {
    throw new Error('Profile needs export destinations for its packs to execute a build');
  }

  const outputPaths = Object.freeze(resolveExportPaths(project, config.packs, exportConfig));
  const outputs = Object.values(config.bedrockCore.profiles).flatMap((settings) => {
    if (!settings.export) {
      return [];
    }

    try {
      return Object.values(resolveExportPaths(project, config.packs, settings.export));
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
      await implementation(step.stage);
    }
  }

  check(signal);
  // Loading is deferred until execution; resolving paths cannot execute module code.
  const require = createRequire(file);
  const modules = new Map<string, string>();

  for (const step of plan.filter(step => step.kind === 'plugin')) {
    const local = step.module.startsWith('.') || path.isAbsolute(step.module);
    const modulePath = local ? path.resolve(project, step.module) : require.resolve(step.module);

    if (local && !inside(project, await realpath(modulePath))) {
      throw new Error(`Plugin module must be inside the project: ${step.module}`);
    }

    modules.set(step.module, modulePath);
  }

  const ignored = new Set(['.git', 'node_modules', '.bedrock-core']);
  const normalized = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
  const isOutput = (file: string) => outputs.some(output =>
    path.relative(output, file) === '' || normalized(file).startsWith(`${normalized(output)}.builder-`),
  );

  // Reject symlinks before copying or publishing, including export parent directories.
  async function inspect(directory: string, skipIgnored = true): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);

      if (skipIgnored && (isOutput(source) || ignored.has(entry.name))) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are unsupported in staged sources: ${source}`);
      }

      if (entry.isDirectory()) {
        await inspect(source, skipIgnored);
      }
    }
  }

  await inspect(project);

  return withExportPaths(outputPaths, async (publish) => {
    let workspace: string | undefined;
    const dependencies = new Set([file, ...modules.values()]);
    const artifacts = new Map<string, Artifact>();
    const generatedImports = new Map<string, string>();
    const stageResults: BuildResult['stages'] = [];
    let publishedPacks: PackInfo[] = [];
    let validation: ContentValidationResult;

    try {
      workspace = await mkdtemp(path.join(tmpdir(), 'bedrock-core-build-'));
      const staged = path.join(workspace, 'project');

      await cp(project, staged, {
        recursive: true,
        filter: source =>
          !isOutput(source) && !ignored.has(path.basename(source)),
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
        namespace: config.namespace,
        stagedRoot: staged,
        generatedDir: generated,
        cache: config.bedrockCore.profiles[profile]?.cache !== false,
        get generatedImports() {
          return Object.freeze(Object.fromEntries(generatedImports));
        },
        packs: Object.freeze(stagedPacks),
        outputPaths,
        profile,
        logger,
        signal,
        registerDependency(filePath: string) {
          dependencies.add(path.resolve(project, filePath));
        },
        async registerArtifact(id: string, filePath: string, options?: { importAs?: string }) {
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

          if (importAs !== undefined) {
            if (typeof importAs !== 'string' || !importAs.trim()) {
              throw new Error(`Artifact import name must be nonempty: ${id}`);
            }

            if (generatedImports.has(importAs)) {
              throw new Error(`Generated import already registered: ${importAs}; owned by ${generatedImports.get(importAs)}`);
            }

            generatedImports.set(importAs, id);
          }

          artifacts.set(id, Object.freeze({ id, path: location, owner, ...(importAs ? { importAs } : {}) }));
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

          return inspectPack(id, directory);
        },
      });

      attachCache(context, cache);

      for (const [index, step] of plan.entries()) {
        check(signal);
        owner = step.kind === 'plugin' ? `${step.plugin}:${index}` : step.stage;
        cache.boundary();

        if (step.kind === 'plugin' || ['prepare', 'validate', 'export'].includes(owner)) {
          logger.info?.(`@bedrock-core/builder: ${owner}`);
        }

        if (step.kind === 'plugin') {
          const module = modules.get(step.module)!;
          const local = step.module.startsWith('.') || path.isAbsolute(step.module);
          const pluginFile = local ? path.join(staged, path.relative(project, module)) : module;
          const url = pathToFileURL(pluginFile);

          url.searchParams.set('build', path.basename(workspace));
          const plugin = await import(url.href);

          if (typeof plugin.run !== 'function') {
            throw new Error(`Plugin must export run(context, settings): ${step.plugin}`);
          }

          await plugin.run(context, step.settings);
        } else if (step.stage === 'validate') {
          for (const artifact of artifacts.values()) {
            const current = await realpath(artifact.path);

            if (!inside(workspace, current) || !(await stat(current)).isFile()) {
              throw new Error(`Invalid registered artifact: ${artifact.id}`);
            }
          }

          await validateArtifacts?.(context);
          await validatePackManifests(stagedPacks);
          validation = await validatePackContent({
            packs: await Promise.all(Object.keys(stagedPacks).map(id => context.inspectPack(id))),
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

          logger.info?.(`@bedrock-core/builder: validated ${checked} content documents against Mojang schemas ${validation.schemaVersion}; ${validation.files.length - checked} additional JSON documents checked for syntax`);
          const schemaIssues = new Set(validation.files.flatMap(file => file.schemaIssue ? [file.schemaIssue] : []));

          for (const issue of schemaIssues) {
            logger.warn?.(`@bedrock-core/builder: ${issue}`);
          }
        } else if (step.stage === 'export') {
          publishedPacks = await Promise.all(Object.keys(stagedPacks).map(id => context.inspectPack(id)));
          await inspect(staged, false);
          check(signal);
          await publish(stagedPacks, signal);
        } else if (step.stage !== 'prepare') {
          const detection = step.mode === 'auto' ? await detectStage(context, step.stage) : undefined;

          if (detection && !detection.needed) {
            stageResults.push({ stage: step.stage, status: 'skipped', reason: detection.reason });
            logger.info?.(`@bedrock-core/builder: ${step.stage} skipped (${detection.reason})`);
            continue;
          }

          const run = await implementation(step.stage);
          const outcome = await run(context, step.settings ?? {});
          const status = outcome?.cached ? 'cached' : 'executed';
          const reason = outcome?.reason ?? detection?.reason;

          stageResults.push({ stage: step.stage, status, reason });
          logger.info?.(`@bedrock-core/builder: ${step.stage} ${status}${reason ? ` (${reason})` : ''}`);
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
        profile,
        stages: stageResults,
        dependencies: [...dependencies],
        compilations: cache.results,
        artifacts: [...artifacts.values()].map(({ id, owner, importAs }) => ({ id, owner, ...(importAs ? { importAs } : {}) })),
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
  });
}
