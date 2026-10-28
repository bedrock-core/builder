import { createHash } from 'node:crypto';
import { glob, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, generatedAliases, hasFiles, resolveFeaturePacks, type BuildContext, type BuildDetection, type BuildStepResult } from '@bedrock-core/builder-plugin';
import { readScriptEntries } from '@bedrock-core/builder-manifest';
import { scriptCandidates, scriptSource } from '@bedrock-core/builder-bundler/entries';
import { compilerFingerprint } from '@bedrock-core/builder-bundler/compile';
import { desugarJsxConditionals } from './sugar.ts';
import { markRuntimeText } from './text.ts';
import {
  bundleUiLibrary,
  bundleUiModule,
  bundleUiDeclaration,
  UiEvaluator,
  uiCompilerVersion,
  readPackLocales,
  uiRegistration,
  writeUiResource,
  writeUiHosts,
  readUiDeclaration,
  declaredApps,
  declaredScreens,
  type UiBundle,
  type ScreenData,
  type ScreenEntry,
  type LinkedUi,
  type PackLocales,
  type UiSettings,
} from './internal.ts';
import { writeTestMetadata } from './metadata.ts';
import { prepareOreAssets } from './ore-assets.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function implementation(files: string[], bundler = false): Promise<string> {
  const sources = files.map(file => new URL(file.replace(/\.ts$/, new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'), import.meta.url));
  const version = await fingerprint([new URL(import.meta.url), ...sources]);

  return bundler ? version + await compilerFingerprint() : version;
}

async function hasInstalledPackage(root: string, names: string[]): Promise<boolean> {
  let directory = root;

  while (true) {
    if (await hasFiles(directory, names.map(name => `node_modules/@bedrock-core/${name}/package.json`))) {
      return true;
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      return false;
    }

    directory = parent;
  }
}

/** Compile the owner's screens and link them into its selected local resource pack. */
export async function run(context: BuildContext, settings: UiSettings): Promise<BuildStepResult> {
  const namespace = settings.namespace ?? context.namespace;
  const resources: string[] = [];
  const behaviors: string[] = [];
  const scriptEntries: string[] = [];
  const entries: ScreenEntry[] = [];

  const routed = await resolveFeaturePacks(context, settings);

  for (const pack of routed) {
    const id = pack.id;

    if (pack.kind === 'resource') {
      resources.push(pack.path);
    } else if (pack.kind === 'behavior') {
      behaviors.push(pack.path);

      for (const entry of await readScriptEntries(id, pack.path)) {
        scriptEntries.push(await scriptSource(id, path.resolve(pack.path, entry)));
      }
    }

    for await (const file of glob('scripts/**/*.screen.tsx', { cwd: pack.path })) {
      entries.push({ source: path.join(pack.path, file), name: path.basename(file, '.screen.tsx') });
    }
  }

  entries.sort((a, b) => a.source.localeCompare(b.source));
  const directory = path.join(context.generatedDir, 'ui');

  await mkdir(directory, { recursive: true });
  const sourceSettings = {
    root: context.stagedRoot,
    dependencyRoot: context.projectRoot,
    aliases: generatedAliases(context, {}, routed[0].id),
    guides: Object.hasOwn(context.generatedImportsFor?.(routed[0].id) ?? context.generatedImports, '@bedrock-core/generated/guides'),
    tsconfig: settings.tsconfig,
    signal: context.signal,
  };
  const aliases = Object.fromEntries(Object.entries(sourceSettings.aliases).map(([name, file]) => [name, path.relative(context.stagedRoot, file)]));
  const compilerKey = {
    implementation: await implementation(['bundle.ts', 'sugar.ts', 'text.ts', 'stubs/game.ts'], true),
    compiler: uiCompilerVersion,
    aliases,
    tsconfig: settings.tsconfig ?? null,
    nodePath: process.env.NODE_PATH ?? '',
  };
  const rendererVersion = await implementation(['worker.ts']);
  let linked: LinkedUi | undefined;
  let evaluator: UiEvaluator | undefined;
  let reused = 0;
  let compiledModules = 0;
  let oreClient: string | undefined;
  const moduleSources = new Set(settings.screens ?? []);
  const shapedSources = new Set<string>();

  const declarationEntries = await hasInstalledPackage(context.projectRoot, ['server', 'server-runtime']) ? scriptEntries : [];

  for (const entry of declarationEntries) {
    const relative = path.relative(context.stagedRoot, entry).replaceAll('\\', '/');
    const compiled = await context.reuse(`declaration:${relative}`, {
      inputs: [entry], key: compilerKey,
      async run() {
        const result = await bundleUiDeclaration({ ...sourceSettings, source: entry });

        return { value: result.code, inputs: result.inputs };
      },
    });
    const file = path.join(directory, `declaration-${digest(relative)}.mjs`);

    compiledModules += Number(!compiled.cached);
    await writeFile(file, compiled.value);
    const read = await readUiDeclaration(file, context.signal);

    if (!read.declaration) {
      if (read.failure) {
        context.logger.warn?.(`UI declaration in ${relative} registered nothing: ${read.failure}`);
      }

      continue;
    }

    const apps = declaredApps(read.declaration).map(app => ({
      ...app,
      compiled: app.compiled.startsWith('.') ? path.resolve(context.stagedRoot, app.compiled) : app.compiled,
    }));

    if (apps.length) {
      const shaped = path.join(directory, `declared-${digest(relative)}.ts`);

      await writeFile(shaped, declaredScreens(apps, read.declaration));
      shapedSources.add(shaped);
      moduleSources.add(shaped);
      apps.forEach(app => moduleSources.add(app.compiled));
    }
  }

  try {
    if (entries.length || moduleSources.size) {
      if (!/^[a-z0-9_]+$/.test(namespace)) {
        throw new Error(`UI namespace ${namespace} must contain lowercase a-z, 0-9 and underscores`);
      }

      if (!resources.length) {
        throw new Error('UI screens require a configured resource pack for their compiled assets');
      }

      const library = await context.reuse('library', {
        inputs: [], key: compilerKey,
        async run() {
          const result = await bundleUiLibrary(sourceSettings);

          return { value: result.code, inputs: result.inputs, cache: result.cacheable };
        },
      });
      const libraryFile = path.join(directory, 'library.mjs');

      compiledModules += Number(!library.cached);
      await writeFile(libraryFile, library.value);
      const libraryVersion = digest(library.value);
      const i18nFile = sourceSettings.aliases['@bedrock-core/generated/i18n'];
      const i18n = i18nFile ? JSON.parse(await readFile(i18nFile, 'utf8')) as { defaultLocale?: string } : undefined;
      let locales: PackLocales | undefined;

      for (const pack of resources) {
        const current = readPackLocales(path.join(pack, 'texts'), i18n?.defaultLocale ?? 'en_US');

        if (current) {
          locales ??= { defaultLocale: current.defaultLocale, tables: {} };

          for (const [locale, values] of Object.entries(current.tables)) {
            Object.assign(locales.tables[locale] ??= {}, values);
          }
        }
      }

      const environment = digest(JSON.stringify({ i18n: i18n ?? null, locales: locales ?? null }));

      const currentEvaluator = evaluator = new UiEvaluator({ library: libraryFile, i18n, locales }, context.signal);
      const exports = await currentEvaluator.request<Record<string, string[]>>({ kind: 'exports' });
      const modules = new Map<string, { file: string; bundle: UiBundle }>();

      const moduleFor = async (source: string) => {
        if (!modules.has(source)) {
          const relative = path.isAbsolute(source) ? path.relative(context.stagedRoot, source).replaceAll('\\', '/') : source;
          const result = await context.reuse(`module:${relative}`, {
            inputs: path.isAbsolute(source) ? [source] : [], key: { ...compilerKey, exports },
            async run() {
              const result = await bundleUiModule({ ...sourceSettings, source, exports });

              return { value: { code: result.code, cacheable: result.cacheable }, inputs: result.inputs };
            },
          });
          const file = path.join(directory, `module-${digest(relative)}.mjs`);

          for (const input of result.inputs) {
            if (/\.(?:ts|tsx|mts|cts)$/.test(input) && routed.some(pack => input.startsWith(`${pack.path}${path.sep}`))) {
              context.excludeFromExport?.(input);
            }
          }

          compiledModules += Number(!result.cached);
          await writeFile(file, result.value.code);
          modules.set(source, { file, bundle: { ...result.value, inputs: result.inputs } });
        }

        return modules.get(source)!;
      };

      for (const source of moduleSources) {
        const resolved = source.startsWith('.') ? path.resolve(context.stagedRoot, source) : source;
        const module = await moduleFor(resolved);
        const names = await evaluator.request<string[]>({ kind: 'list', module: module.file });

        if (!names.length && !shapedSources.has(resolved)) {
          throw new Error(`UI module ${source} must default-export a record of screens`);
        }

        names.forEach(name => entries.push({ source: resolved, name, member: name }));
      }

      const names = new Set<string>();
      const screens: ScreenData[] = [];

      for (const entry of entries) {
        if (!/^[_A-Za-z0-9][_A-Za-z0-9.-]*$/.test(entry.name) || entry.name === 'faces' || (settings.stamp && entry.name === 'core_build')) {
          throw new Error(`Screen name ${entry.name} is not a usable UI output filename`);
        }

        if (names.has(entry.name)) {
          throw new Error(`Two UI screens are named ${entry.name}`);
        }

        names.add(entry.name);
        const module = await moduleFor(entry.source);
        const result = await context.reuse(`screen:${entry.name}`, {
          inputs: module.bundle.inputs,
          key: {
            rendererVersion,
            libraryVersion,
            environment,
            namespace,
            module: digest(module.bundle.code),
            member: entry.member ?? null,
            testMetadata: settings.testMetadata === true,
          },
          cache: module.bundle.cacheable,
          async run() {
            const screen = await currentEvaluator.request<ScreenData>({
              kind: 'screen',
              module: module.file,
              name: entry.name,
              member: entry.member,
              namespace,
              testMetadata: settings.testMetadata,
            });

            if (settings.testMetadata && screen.ore === undefined && !screen.testMetadata) {
              throw new Error('The installed @bedrock-core UI compiler does not support testMetadata');
            }

            return { value: screen };
          },
        });

        reused += Number(result.cached);
        screens.push(result.value);

        if (entries.length >= 500 && screens.length % 250 === 0) {
          context.logger.info?.(`@bedrock-core/builder: UI ${screens.length}/${entries.length} screens checked (${reused} reused)`);
        }
      }

      linked = await evaluator.request<LinkedUi>({ kind: 'link', screens, namespace });
    }
  } finally {
    await evaluator?.close();
  }

  if (linked) {
    const metadataEntries = entries.map(entry => ({
      ...entry,
      source: path.isAbsolute(entry.source)
        ? path.relative(context.stagedRoot, entry.source).replaceAll('\\', '/')
        : entry.source,
    }));
    const files = await writeUiHosts(behaviors, linked, settings);

    for (const pack of resources) {
      files.push(...await writeUiResource(pack, linked, metadataEntries, namespace, settings));
      const layouts = (linked.resources ?? []).filter(resource => /^hbui\/core-ore\/[A-Za-z0-9_-]+\.json$/.test(resource.file)).map(resource => resource.file);

      if (linked.screens.some(screen => screen.ore !== undefined)) {
        const prepared = await prepareOreAssets({
          pack, layouts, projectRoot: context.projectRoot, stagedRoot: context.stagedRoot,
          targetVersion: context.project?.targetVersion, settings: settings.experimentalOre,
          registerDependency: file => context.registerDependency(file),
        });

        files.push(...prepared.files);
        oreClient = prepared.version;
      }
    }

    for (const file of new Set(files)) {
      const pack = routed.map(pack => [pack.id, pack.path] as const).find(([, directory]) => file.startsWith(`${directory}${path.sep}`))!;

      await context.registerArtifact(`ui:${pack[0]}:${path.relative(pack[1], file).replaceAll('\\', '/')}`, file);
    }
  } else {
    resources.forEach(pack => writeTestMetadata(pack, [], false));
  }

  const generated = path.join(directory, 'ui.generated.ts');
  const screens = linked?.screens ?? [];

  await writeFile(generated, uiRegistration(linked ?? { screens: [] }, entries, directory, namespace));
  await context.registerArtifact('ui:bundle', generated, { importAs: '@bedrock-core/generated/ui' });

  if (screens.length) {
    for (const file of scriptEntries) {
      const source = await readFile(file, 'utf8');

      await writeFile(file, `import '@bedrock-core/generated/ui';\n${source}`);
    }
  }

  context.registerBundleExtension({
    id: '@bedrock-core/ui',
    version: await implementation(['sugar.ts', 'text.ts']),
    packs: Object.entries(context.packs).filter(([, directory]) => behaviors.includes(directory)).map(([id]) => id),
    jsxImportSource: '@bedrock-core/ui',
    resolveFromProject: ['@bedrock-core/'],
    cache: true,
    plugins: [{
      name: '@bedrock-core/ui-screens',
      setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const prepared = args.path.endsWith('.screen.tsx') ? desugarJsxConditionals(source, args.path) : source;
          const extension = path.extname(args.path);

          return { contents: markRuntimeText(prepared, args.path), loader: extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : extension.endsWith('ts') ? 'ts' : 'js', watchFiles: [args.path] };
        });
      },
    }],
  });

  const declarations = path.join(context.projectRoot, '.bedrock-core/generated/ui/screens.generated.d.ts');
  const content = [
    'declare module \'@bedrock-core/navigation\' {',
    '  interface ScreenKeys {',
    ...screens.map(screen => `    ${JSON.stringify(`${namespace}:${screen.name}`)}: true;`),
    '  }', '}', 'export {};', '',
  ].join('\n');

  await mkdir(path.dirname(declarations), { recursive: true });
  let previous: string | undefined;

  try {
    previous = await readFile(declarations, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (content !== previous) {
    await writeFile(declarations, content);
  }

  return {
    cached: compiledModules === 0 && reused === entries.length && oreClient === undefined,
    reason: `${compiledModules} modules bundled; ${entries.length - reused} screens compiled, ${reused} reused${oreClient ? `; Ore assets for ${oreClient}` : ''}`,
  };
}

/** Detect screen files, generated declarations or framework declaration inputs. */
export async function detect(context: BuildContext, settings: UiSettings = {}): Promise<BuildDetection> {
  context.signal?.throwIfAborted();
  const packPaths = Object.values(context.packs).map(directory => path.relative(context.stagedRoot, directory).replaceAll('\\', '/'));
  let needed = !!settings.screens?.length;
  let input = 'configured screen modules';

  if (!needed) {
    needed = await hasFiles(context.stagedRoot, packPaths.map(directory => `${directory}/scripts/**/*.screen.tsx`));
    input = 'screen modules in pack scripts';

    if (!needed) {
      needed = await hasFiles(context.projectRoot, '.bedrock-core/generated/ui/screens.generated.d.ts');
      input = needed ? 'generated UI declarations to refresh' : input;
    }

    if (!needed) {
      for (const id of Object.keys(context.packs)) {
        const pack = await context.inspectPack(id);

        if (pack.kind !== 'behavior') {
          continue;
        }

        for (const entry of await readScriptEntries(id, pack.path)) {
          let source = '';

          for (const file of scriptCandidates(path.resolve(pack.path, entry))) {
            try {
              if ((await stat(file)).isFile()) {
                source += await readFile(file, 'utf8');
              }
            } catch (error) {
              if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                throw error;
              }
            }
          }

          if (source.includes('@bedrock-core/generated/ui')) {
            needed = true;
            input = 'generated UI imports in manifest entries';
          } else if (source && await hasInstalledPackage(context.projectRoot, ['server', 'server-runtime'])) {
            needed = await hasInstalledPackage(context.projectRoot, ['ui']);
            input = 'addon declarations with the installed UI toolkit';
          }
        }
      }
    }
  }

  return { needed, reason: `${needed ? 'Found' : 'No'} ${input}` };
}
