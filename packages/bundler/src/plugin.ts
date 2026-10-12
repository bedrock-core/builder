import path from 'node:path';
import { copyFile, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fingerprint, generatedAliases, type BuildContext, type BuildDetection, type BuildStepResult } from '@bedrock-core/builder-plugin';
import { readScriptEntries } from '@bedrock-core/builder-manifest';
import { bundleScripts, compilerVersion } from './index.ts';

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

async function discoverScripts(context: BuildContext, settings: BundlerSettings): Promise<ScriptBuild[]> {
  const scripts: ScriptBuild[] = [];

  for (const packId of Object.keys(context.packs)) {
    const pack = await context.inspectPack(packId);

    if (pack.kind !== 'behavior') {
      continue;
    }

    const entries = await readScriptEntries(packId, pack.path);
    const uniqueEntries = new Set<string>();

    context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, pack.path), 'manifest.json'));

    for (const runtimeEntry of entries) {
      const output = path.resolve(pack.path, runtimeEntry);

      if (!within(pack.path, output) || uniqueEntries.has(output)) {
        throw new Error(`Pack ${packId} has an invalid or duplicate manifest script entry: ${runtimeEntry}`);
      }

      uniqueEntries.add(output);

      if (settings.debug && await exists(`${output}.map`)) {
        throw new Error(`Bundler output already exists: ${output}.map`);
      }

      scripts.push({
        packId,
        packPath: pack.path,
        runtimeEntry,
        source: await scriptSource(packId, output),
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

  for (const script of scripts) {
    const aliases = generatedAliases(context, settings.generatedImports, script.packId);
    const extensions = context.bundleExtensions.filter(extension => !extension.packs || extension.packs.includes(script.packId));
    const jsxSources = new Set(extensions.flatMap(extension => extension.jsxImportSource ? [extension.jsxImportSource] : []));

    if (jsxSources.size > 1) {
      throw new Error(`Conflicting JSX runtime extensions for pack ${script.packId}`);
    }

    const plugins = extensions.flatMap(extension => [...(extension.plugins ?? [])]);
    const pluginInputs = extensions.flatMap(extension => [...(extension.inputs ?? [])]);
    const resolveFromProject = extensions.flatMap(extension => [...(extension.resolveFromProject ?? [])]);
    const id = `${script.packId}:${script.runtimeEntry}`;
    const result = await context.reuse(id, {
      inputs: [script.source, ...pluginInputs],
      cache: extensions.every(extension => !extension.plugins?.length || extension.cache === true),
      key: {
        version,
        compilerVersion,
        nodePath: process.env.NODE_PATH ?? '',
        debug: settings.debug ?? false,
        target: settings.target ?? 'es2020',
        tsconfig: settings.tsconfig ?? null,
        external: settings.external ?? [],
        extensions: extensions.map(extension => ({ id: extension.id, version: extension.version, jsxImportSource: extension.jsxImportSource ?? null, resolveFromProject: extension.resolveFromProject ?? [] })),
        aliases: Object.fromEntries(Object.entries(aliases).map(([name, file]) => [name, path.relative(context.stagedRoot, file)])),
      },
      async run() {
        const bundle = await bundleScripts({
          root: context.stagedRoot,
          dependencyRoot: context.projectRoot,
          entry: script.source,
          outfile: script.temporaryOutput,
          debug: settings.debug,
          target: settings.target,
          tsconfig: settings.tsconfig,
          external: settings.external,
          aliases,
          plugins,
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

  // Keep staged inputs intact until every bundle has finished, including JS entries.
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

  for (const source of sources) {
    await unlink(source);
  }

  if (settings.tsconfig) {
    context.registerDependency(settings.tsconfig);
  }

  return { cached: cached === scripts.length, reason: `${scripts.length - cached} built, ${cached} reused` };
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
