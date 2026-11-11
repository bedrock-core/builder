import path from 'node:path';
import { copyFile, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fingerprint, generatedAliases, type BuildContext, type BuildDetection, type BuildStepResult } from '@bedrock-core/builder-plugin';
import { readScriptEntries, scriptOutputEntry, scriptOutputManifest, type JsonObject } from '@bedrock-core/builder-manifest';
import { bundleScripts, compilerVersion } from './index.ts';
import { apiExports, needsNativeAccess } from './api.ts';
import { emitApiPackage } from './api-package.ts';

export interface BundlerSettings {
  debug?: boolean;
  target?: string;
  tsconfig?: string;
  external?: string[];
  generatedImports?: Record<string, string>;
}

interface ScriptBuild {
  packId: string;
  packPath: string;
  runtimeEntry: string;
  source: string;
  output: string;
  temporaryOutput: string;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

import { scriptSource } from './entries.ts';
import { compilerFingerprint } from './compile.ts';

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

// Bedrock loads the bundled JavaScript; other authored TypeScript in scripts is build input.
async function collectPackTypeScript(directory: string, sources: Set<string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectPackTypeScript(file, sources);
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      sources.add(file);
    }
  }
}

async function discoverScripts(context: BuildContext, settings: BundlerSettings): Promise<ScriptBuild[]> {
  const scripts: ScriptBuild[] = [];

  for (const packId of Object.keys(context.packs)) {
    const pack = await context.inspectPack(packId);

    if (pack.kind !== 'behavior') {
      continue;
    }

    const entries = await readScriptEntries(packId, pack.path);
    const uniqueEntries = new Map<string, string>();

    context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, pack.path), 'manifest.json'));

    for (const entry of entries) {
      const runtimeEntry = scriptOutputEntry(entry);
      const output = path.resolve(pack.path, runtimeEntry);
      const key = process.platform === 'win32' ? output.toLowerCase() : output;
      const previous = uniqueEntries.get(key);

      if (!within(pack.path, output)) {
        throw new Error(`Pack ${packId} manifest entry ${entry} must stay under scripts/ inside its pack.`);
      }

      if (previous !== undefined) {
        throw new Error(`Pack ${packId} manifest entries ${previous} and ${entry} share output ${runtimeEntry}. Use a distinct script filename for each module.`);
      }

      uniqueEntries.set(key, entry);

      if (settings.debug && await exists(`${output}.map`)) {
        throw new Error(`Pack ${packId} manifest entry ${entry} collides with the authored source map ${runtimeEntry}.map. Move or remove that file.`);
      }

      scripts.push({
        packId,
        packPath: pack.path,
        runtimeEntry,
        source: await scriptSource(packId, path.resolve(pack.path, entry), pack.path),
        output,
        temporaryOutput: path.join(context.generatedDir, 'bundler', packId, runtimeEntry),
      });
    }
  }

  return scripts;
}

/** Bundle every script module using only its current staged manifest entry. */
export async function run(context: BuildContext, settings: BundlerSettings): Promise<BuildStepResult> {
  const scripts = await discoverScripts(context, settings);
  const sources = new Set<string>();
  const outputs: { temporary: string; destination: string; artifactId: string }[] = [];
  const version = await fingerprint([new URL(import.meta.url)]) + await compilerFingerprint();
  let cached = 0;
  const apiManifests = new Map<string, JsonObject>();
  const apiInputs = new Set<string>();
  const updatedManifests = new Map<string, string>();

  for (const script of scripts) {
    const manifestPath = path.join(script.packPath, 'manifest.json');
    const text = await readFile(manifestPath, 'utf8');
    const authored = JSON.parse(text) as JsonObject;
    const manifest = scriptOutputManifest(authored);

    if (manifest !== authored && !updatedManifests.has(manifestPath)) {
      const indent = text.match(/\n([ \t]+)"/)?.[1];

      updatedManifests.set(manifestPath, JSON.stringify(manifest, null, indent) + (text.endsWith('\n') ? '\n' : ''));
    }

    const provider = await apiExports(context.projectRoot, manifest);

    if (provider.owns) {
      apiManifests.set(script.packId, manifest);
      provider.inputs.forEach(file => apiInputs.add(file));
    }

    let entry = script.source;

    if (provider.modules.length) {
      entry = path.join(context.generatedDir, 'api', script.packId, `${path.basename(script.runtimeEntry)}.ts`);

      const specifier = (source: string): string => {
        const relative = path.relative(path.dirname(entry), source).replaceAll('\\', '/');

        return relative.startsWith('.') ? relative : `./${relative}`;
      };

      const contents = [
        ...provider.modules.map((module) => {
          const source = path.join(context.stagedRoot, path.relative(context.projectRoot, module.source));

          return `import ${JSON.stringify(specifier(source))};`;
        }),
        `import ${JSON.stringify(specifier(script.source))};`,
      ].join('\n');

      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, contents);
    }

    const aliases = generatedAliases(context, settings.generatedImports, script.packId);
    const extensions = context.bundleExtensions.filter(extension => !extension.packs || extension.packs.includes(script.packId));
    const jsxSources = new Set(extensions.flatMap(extension => extension.jsxImportSource ? [extension.jsxImportSource] : []));

    if (jsxSources.size > 1) {
      throw new Error(`Conflicting JSX runtime extensions for pack ${script.packId}`);
    }

    const plugins = extensions.flatMap(extension => [...(extension.plugins ?? [])]);
    const pluginInputs = extensions.flatMap(extension => [...(extension.inputs ?? [])]);
    const resolveFromProject = extensions.flatMap(extension => [...(extension.resolveFromProject ?? [])]);
    const moduleNames = [...new Set(extensions.flatMap(extension => extension.moduleNames ?? []))].sort();
    const id = `${script.packId}:${script.runtimeEntry}`;
    const result = await context.reuse(id, {
      inputs: [script.source, ...pluginInputs, ...provider.inputs],
      cache: extensions.every(extension => !extension.plugins?.length || extension.cache === true),
      key: {
        version,
        compilerVersion,
        nodePath: process.env.NODE_PATH ?? '',
        debug: settings.debug ?? false,
        target: settings.target ?? 'es2020',
        tsconfig: settings.tsconfig ?? null,
        external: settings.external ?? [],
        moduleNames,
        provides: provider.modules.map(module => ({ moduleName: module.moduleName, shape: module.shape, source: path.relative(context.projectRoot, module.source) })),
        extensions: extensions.map(extension => ({ id: extension.id, version: extension.version, jsxImportSource: extension.jsxImportSource ?? null, resolveFromProject: extension.resolveFromProject ?? [] })),
        aliases: Object.fromEntries(Object.entries(aliases).map(([name, file]) => [name, path.relative(context.stagedRoot, file)])),
      },
      async run() {
        const bundle = await bundleScripts({
          root: context.stagedRoot,
          dependencyRoot: context.projectRoot,
          entry,
          outfile: script.temporaryOutput,
          debug: settings.debug,
          target: settings.target,
          tsconfig: settings.tsconfig,
          external: settings.external,
          moduleNames,
          nativeAccess: provider.modules.some(module => needsNativeAccess(module.shape)),
          provides: provider.modules,
          aliases,
          plugins,
          cachePlugins: extensions.every(extension => !extension.plugins?.length || extension.cache === true),
          resolveFromProject,
          jsxImportSource: [...jsxSources][0],
          signal: context.signal,
        });

        for (const directory of bundle.watchDirs) {
          context.registerDependency(directory);
        }

        return {
          value: { sources: bundle.inputs.map(file => path.relative(context.stagedRoot, file)) },
          inputs: [...bundle.inputs, ...bundle.watchFiles],
          files: bundle.files,
          cache: bundle.cacheable,
        };
      },
    });

    if (result.cached) {
      cached++;
    }

    for (const relative of result.value.sources) {
      const input = path.resolve(context.stagedRoot, relative);

      if (within(context.stagedRoot, input)) {
        context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, input)));
      } else if (!within(context.generatedDir, input)) {
        context.registerDependency(input);
      }

      if (scripts.some(script => within(script.packPath, input)) && /\.(?:ts|tsx|mts|cts)$/.test(input)) {
        sources.add(input);
      }
    }

    for (const temporary of result.files) {
      const sourceMap = temporary.endsWith('.map');

      outputs.push({
        temporary,
        destination: `${script.output}${sourceMap ? '.map' : ''}`,
        artifactId: `bundler:${script.packId}:${script.runtimeEntry}:${sourceMap ? 'sourcemap' : 'script'}`,
      });
    }
  }

  let apiCached = true;

  if (context.apiOutput && apiManifests.size) {
    const directory = path.join(context.generatedDir, 'api-package');
    const emitted = await context.reuse('api:package', {
      inputs: [...apiInputs],
      key: { version, compilerVersion, manifests: [...apiManifests.values()] },
      async run() {
        const result = await emitApiPackage({ root: context.projectRoot, output: directory, manifests: [...apiManifests.values()], signal: context.signal });

        return result
          ? { value: { emitted: true }, inputs: result.inputs, files: result.files }
          : { value: { emitted: false } };
      },
    });

    apiCached = emitted.cached;

    if (emitted.value.emitted) {
      await context.registerArtifact('api:package', path.join(directory, 'package.json'));

      for (const input of emitted.inputs) {
        if (within(context.projectRoot, input) && /\.(?:ts|tsx|mts|cts)$/.test(input) && await exists(input)) {
          const staged = path.join(context.stagedRoot, path.relative(context.projectRoot, input));

          if (scripts.some(script => within(script.packPath, staged))) {
            sources.add(staged);
          }
        }
      }
    }
  }

  // Keep staged inputs intact until every bundle has finished, including JS entries.
  for (const packPath of new Set(scripts.map(script => script.packPath))) {
    await collectPackTypeScript(path.join(packPath, 'scripts'), sources);
  }

  for (const output of outputs) {
    await mkdir(path.dirname(output.destination), { recursive: true });

    if (output.destination.endsWith('.map')) {
      const map = JSON.parse(await readFile(output.temporary, 'utf8')) as { sources: string[] };

      map.sources = map.sources.map(source => path.relative(
        path.dirname(output.destination),
        path.resolve(path.dirname(output.temporary), source),
      ).replaceAll('\\', '/'));
      await writeFile(output.destination, JSON.stringify(map));
    } else {
      await copyFile(output.temporary, output.destination);
    }

    await context.registerArtifact(output.artifactId, output.destination);
  }

  for (const [file, content] of updatedManifests) {
    await writeFile(file, content);
  }

  for (const source of sources) {
    if (context.excludeFromExport) {
      context.excludeFromExport(source);
    } else {
      await unlink(source);
    }
  }

  if (settings.tsconfig) {
    context.registerDependency(settings.tsconfig);
  }

  return { cached: cached === scripts.length && apiCached, reason: `${scripts.length - cached} built, ${cached} reused` };
}

/** Detect manifest script modules without importing their sources. */
export async function detect(context: BuildContext): Promise<BuildDetection> {
  for (const id of Object.keys(context.packs)) {
    if ((await context.inspectPack(id)).moduleTypes.includes('script')) {
      return { needed: true, reason: 'Found manifest script modules' };
    }
  }

  return { needed: false, reason: 'No manifest script modules' };
}
