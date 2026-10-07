import path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { BuildContext, BuildStepResult } from '../contract.d.ts';
import { readScriptEntries } from '../manifest.ts';
import { bundleScripts, compilerVersion } from '../../packages/bundler/src/index.ts';
import { generatedAliases } from '../imports.ts';
import { buildCache } from '../file-cache.ts';

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

export function scriptCandidates(output: string): string[] {
  const stem = output.slice(0, -3);

  return ['.ts', '.tsx', '.mts', '.cts'].map(extension => `${stem}${extension}`).concat(output);
}

export async function scriptSource(packId: string, output: string): Promise<string> {
  const typedSources: string[] = [];

  for (const candidate of scriptCandidates(output).slice(0, -1)) {
    if (await exists(candidate)) {
      typedSources.push(candidate);
    }
  }

  if (typedSources.length > 1) {
    throw new Error(`Pack ${packId} has ambiguous sources for its manifest entry: ${output}`);
  }

  if (typedSources.length === 1) {
    if (await exists(output)) {
      throw new Error(`Bundler output already exists alongside its TypeScript source: ${output}`);
    }

    return typedSources[0]!;
  }

  if (await exists(output)) {
    return output;
  }

  throw new Error(`Pack ${packId} has no TS/JS source matching its manifest entry: ${output}`);
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
  const aliases = generatedAliases(context, settings.generatedImports);
  const ui = Object.hasOwn(context.generatedImports, '@bedrock-core/generated/ui');
  const transformScreen = ui ? (await import('../../packages/ui-compiler/src/sugar.ts')).desugarJsxConditionals : undefined;
  const version = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .update(await readFile(new URL('../../packages/bundler/src/index.ts', import.meta.url)))
    .update(await readFile(new URL('../../packages/bundler/src/dependencies.ts', import.meta.url)))
    .digest('hex');
  const uiVersion = ui ? createHash('sha256').update(await readFile(new URL('../../packages/ui-compiler/src/sugar.ts', import.meta.url))).digest('hex') : null;
  let cached = 0;

  for (const script of scripts) {
    const id = `${script.packId}:${script.runtimeEntry}`;
    const result = await buildCache(context).reuse(id, {
      inputs: [script.source],
      key: {
        version,
        compilerVersion,
        nodePath: process.env.NODE_PATH ?? '',
        debug: settings.debug ?? false,
        target: settings.target ?? 'es2020',
        tsconfig: settings.tsconfig ?? null,
        external: settings.external ?? [],
        uiVersion,
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
          transformScreen,
          projectModules: ui,
          jsxImportSource: ui ? '@bedrock-core/ui' : undefined,
          signal: context.signal,
        });

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
