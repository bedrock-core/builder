import path from 'node:path';
import { stat, lstat, unlink } from 'node:fs/promises';
import type { BuildContext } from '../contract.d.ts';
import { bundleScripts } from '../../packages/bundler/src/index.ts';

export interface BundlerSettings {
  entry?: string;
  pack?: string;
  outfile?: string;
  debug?: boolean;
  target?: string;
  tsconfig?: string;
  external?: string[];
  generatedImports?: Record<string, string>;
}

const within = (root: string, file: string) => {
  const relative = path.relative(root, file);

  return (
    relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

export async function run(context: BuildContext, settings: BundlerSettings): Promise<void> {
  if (!settings.entry) {
    throw new Error('bundler.entry is required; set a TS/JS entry relative to config.json');
  }

  const packs = await Promise.all(Object.keys(context.packs).map(id => context.inspectPack(id)));
  const behaviorPacks = packs.filter(pack => pack.kind === 'behavior');
  const selected = settings.pack
    ? packs.find(pack => pack.id === settings.pack)
    : behaviorPacks.length === 1 ? behaviorPacks[0] : undefined;

  if (!selected || selected.kind !== 'behavior') {
    throw new Error('bundler requires a behavior pack identified by its manifest; set bundler.pack when multiple behavior packs are available');
  }

  const behaviorPack = selected.path;

  const entry = path.resolve(context.stagedRoot, settings.entry);
  const outfile = path.resolve(behaviorPack, settings.outfile ?? 'scripts/main.js');

  if (!within(context.stagedRoot, entry)) {
    throw new Error('bundler.entry must be inside the staged project');
  }

  if (!within(behaviorPack, outfile) || path.extname(outfile) !== '.js') {
    throw new Error('bundler.outfile must be a .js file inside the behavior pack');
  }

  for (const output of [outfile, ...(settings.debug ? [`${outfile}.map`] : [])]) {
    try {
      await lstat(output);
      throw new Error(`Bundler output already exists: ${output}; choose an unused output path`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const aliases = Object.fromEntries(
    Object.entries(settings.generatedImports ?? {}).map(([specifier, artifact]) => [
      specifier,
      context.artifact(artifact).path,
    ]),
  );
  const result = await bundleScripts({
    root: context.stagedRoot,
    dependencyRoot: context.projectRoot,
    entry,
    outfile,
    debug: settings.debug,
    target: settings.target,
    tsconfig: settings.tsconfig,
    external: settings.external,
    aliases,
    signal: context.signal,
  });

  for (const input of result.inputs) {
    if (within(context.stagedRoot, input)) {
      context.registerDependency(
        path.join(context.projectRoot, path.relative(context.stagedRoot, input)),
      );
    } else if (!within(context.generatedDir, input)) {
      context.registerDependency(input);
    }

    // Consumed TypeScript sources are build inputs, not runtime pack artifacts.
    if (within(behaviorPack, input) && /\.(?:ts|tsx|mts|cts)$/.test(input)) {
      await unlink(input);
    }
  }

  if (settings.tsconfig) {
    context.registerDependency(settings.tsconfig);
  }

  for (const output of result.files) {
    if (!(await stat(output)).isFile()) {
      throw new Error(`Missing bundle output: ${output}`);
    }

    await context.registerArtifact(
      output.endsWith('.map') ? 'bundler:sourcemap' : 'bundler:script',
      output,
    );
  }
}
