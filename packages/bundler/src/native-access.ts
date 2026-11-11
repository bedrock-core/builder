import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ModuleKind, ModuleResolutionKind } from 'typescript-native/sync';
import { ScriptTarget } from 'typescript-native/ast';
import { findConfigFile, moduleResolutionOptions, trackedCompiler } from './typescript.ts';
import { instrument } from './native-access-transform.ts';

/** Instrument the exact runtime graph, including erased JavaScript dependencies. */
export function nativeAccessSources(options: {
  sources: ReadonlyMap<string, string>;
  root: string;
  dependencyRoot: string;
  tsconfig?: string;
  aliases: Record<string, string>;
  track(file: string): void;
}): Map<string, string> {
  const track = (file: string): void => {
    const relative = path.relative(file, options.root);

    // Build-owned ancestor directories exist by contract and change identity on every staging run.
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return;
    }

    options.track(file);
  };

  using api = trackedCompiler(track, track, options.sources);
  const config = options.tsconfig ? path.resolve(options.root, options.tsconfig) : findConfigFile(options.root, track);
  const configured = config ? moduleResolutionOptions(api.parseConfigFile(config).options) : {};
  const modulePaths: string[] = [];
  let directory = options.dependencyRoot;

  while (true) {
    modulePaths.push(path.join(directory, 'node_modules/*'));
    const parent = path.dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  const paths = { ...configured.paths, '*': [...configured.paths?.['*'] ?? [], ...modulePaths],
    ...Object.fromEntries(Object.entries(options.aliases).map(([name, file]) => [name, [path.resolve(options.root, file)]])) };
  const program = api.createProgram([...options.sources.keys()], {
    ...configured, paths, pathsBasePath: configured.pathsBasePath ?? options.dependencyRoot,
    target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
    allowJs: true, checkJs: false, strict: true, skipLibCheck: true, types: [], noEmit: true,
    allowImportingTsExtensions: true, resolveJsonModule: true,
  });
  const output = new Map<string, string>();
  const packages = new Map<string, string | undefined>();

  if (!program.getSourceFileNames().some(file => file.replaceAll('\\', '/').includes('/@minecraft/server/'))) {
    throw new Error('Native API lookup tracing requires resolvable @minecraft/server declarations from the project dependency root');
  }

  for (const file of options.sources.keys()) {
    const source = program.getSourceFile(file);

    if (!source || source.isDeclarationFile) {
      continue;
    }

    const metadata = findConfigFile(path.dirname(file), track, 'package.json');

    if (metadata && !packages.has(metadata)) {
      const data: unknown = JSON.parse(readFileSync(metadata, 'utf8'));

      packages.set(metadata, typeof data === 'object' && data !== null && 'name' in data && typeof data.name === 'string' ? data.name : undefined);
    }

    // The receiving tracker and runtime must share one provenance map per addon.
    if (metadata && ['@bedrock-core/server-runtime', '@bedrock-core/sync', '@minecraft/server'].includes(packages.get(metadata) ?? '')) {
      continue;
    }

    const transformed = instrument(program, source, '@bedrock-core/server-runtime/api/native-access', api.printer);

    if (Object.keys(transformed.operations).length) {
      output.set(file, transformed.code);
    }
  }

  return output;
}
