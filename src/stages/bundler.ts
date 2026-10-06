import path from 'node:path';
import { copyFile, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { BuildContext } from '../contract.d.ts';
import { readScriptEntries } from '../manifest.ts';
import { bundleScripts } from '../../packages/bundler/src/index.ts';

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

async function scriptSource(packId: string, output: string): Promise<string> {
  const stem = output.slice(0, -3);
  const typedSources: string[] = [];

  for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
    const candidate = `${stem}${extension}`;

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
export async function run(context: BuildContext, settings: BundlerSettings): Promise<void> {
  const scripts = await discoverScripts(context, settings);
  const sources = new Set<string>();
  const outputs: { temporary: string; destination: string; artifactId: string }[] = [];
  const aliases = Object.fromEntries(
    Object.entries(settings.generatedImports ?? {}).map(([specifier, artifact]) => [
      specifier,
      context.artifact(artifact).path,
    ]),
  );

  for (const script of scripts) {
    const result = await bundleScripts({
      root: context.stagedRoot,
      dependencyRoot: context.projectRoot,
      entry: script.source,
      outfile: script.temporaryOutput,
      debug: settings.debug,
      target: settings.target,
      tsconfig: settings.tsconfig,
      external: settings.external,
      aliases,
      signal: context.signal,
    });

    for (const input of result.inputs) {
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
}
