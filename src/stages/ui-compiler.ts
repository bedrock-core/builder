import { createHash } from 'node:crypto';
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext, BuildStepResult } from '../contract.d.ts';
import { buildCache } from '../file-cache.ts';
import { generatedAliases } from '../imports.ts';
import { readScriptEntries } from '../manifest.ts';
import { scriptSource } from './bundler.ts';
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
} from '../../packages/ui-compiler/src/index.ts';
import { writeTestMetadata } from '../../packages/ui-compiler/src/metadata.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function implementation(files: string[]): Promise<string> {
  const hash = createHash('sha256');

  for (const file of files) {
    hash.update(await readFile(new URL(`../../packages/ui-compiler/src/${file}`, import.meta.url)));
  }

  return hash.digest('hex');
}

/** Compile screens independently, then link the current set into all configured resource packs. */
export async function run(context: BuildContext, settings: UiSettings): Promise<BuildStepResult> {
  const namespace = settings.namespace ?? context.namespace;
  const resources: string[] = [];
  const behaviors: string[] = [];
  const scriptEntries: string[] = [];
  const entries: ScreenEntry[] = [];

  for (const id of Object.keys(context.packs)) {
    const pack = await context.inspectPack(id);

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
    aliases: generatedAliases(context),
    tsconfig: settings.tsconfig,
    signal: context.signal,
  };
  const aliases = Object.fromEntries(Object.entries(sourceSettings.aliases).map(([name, file]) => [name, path.relative(context.stagedRoot, file)]));
  const compilerKey = {
    implementation: await implementation(['bundle.ts', 'sugar.ts', 'stubs/game.ts', '../../bundler/src/dependencies.ts']),
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
  const moduleSources = new Set(settings.screens ?? []);
  const shapedSources = new Set<string>();

  for (const entry of scriptEntries) {
    const source = await readFile(entry, 'utf8');

    if (!/['"]@bedrock-core\/server(?:-runtime)?['"]/.test(source)) {
      continue;
    }

    const relative = path.relative(context.stagedRoot, entry).replaceAll('\\', '/');
    const compiled = await buildCache(context).reuse(`declaration:${relative}`, {
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

      const library = await buildCache(context).reuse('library', {
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
          const result = await buildCache(context).reuse(`module:${relative}`, {
            inputs: path.isAbsolute(source) ? [source] : [], key: { ...compilerKey, exports },
            async run() {
              const result = await bundleUiModule({ ...sourceSettings, source, exports });

              return { value: { code: result.code, cacheable: result.cacheable }, inputs: result.inputs };
            },
          });
          const file = path.join(directory, `module-${digest(relative)}.mjs`);

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
        const result = await buildCache(context).reuse(`screen:${entry.name}`, {
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

            if (settings.testMetadata && !screen.testMetadata) {
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
    }

    for (const file of files) {
      const pack = Object.entries(context.packs).find(([, directory]) => file.startsWith(`${directory}${path.sep}`))!;

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

  const declarations = path.join(context.projectRoot, '.bedrock-core/generated/ui/screens.generated.d.ts');
  const content = [
    'declare module \'@bedrock-core/ui-runtime\' {',
    '  interface ScreenKeys {',
    ...screens.filter(screen => !screen.host).map(screen => `    ${JSON.stringify(`${namespace}:${screen.name}`)}: true;`),
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
    cached: compiledModules === 0 && reused === entries.length,
    reason: `${compiledModules} modules bundled; ${entries.length - reused} screens compiled, ${reused} reused`,
  };
}
