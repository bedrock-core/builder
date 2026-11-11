import { statSync } from 'node:fs';
import path from 'node:path';
import { serverFS } from 'typescript-native/fs';
import { API, type CompilerOptions, type Diagnostic, type Program, type RawCompilerOptions } from 'typescript-native/sync';

export type ResolutionOptions = CompilerOptions & { baseUrl?: string; pathsBasePath?: string };

/** Preserve baseUrl lookup for projects still using older TypeScript configs. */
export function moduleResolutionOptions(options: ResolutionOptions): RawCompilerOptions {
  const { baseUrl, ...native } = options;

  if (!baseUrl) {
    return native;
  }

  const paths = Object.fromEntries(Object.entries(options.paths ?? {}).map(([pattern, destinations]) => [
    pattern, [...destinations, `./${pattern}`],
  ]));

  paths['*'] ??= ['./*'];

  return { ...native, paths, pathsBasePath: baseUrl };
}

/** Find the nearest file and retain missing candidates for cache invalidation. */
export function findConfigFile(directory: string, track: (file: string) => void, name = 'tsconfig.json', root?: string): string | undefined {
  while (true) {
    const file = path.join(directory, name);

    track(file);

    if (statSync(file, { throwIfNoEntry: false })?.isFile()) {
      return file;
    }

    const parent = path.dirname(directory);

    if (parent === directory || (root !== undefined && !path.relative(root, directory))) {
      return undefined;
    }

    directory = parent;
  }
}

/** Track native filesystem lookups without taking ownership of writes. */
export function trackedCompiler(track: (file: string) => void, trackDirectory = track, sources?: ReadonlyMap<string, string>): API {
  const probe = (file: string): typeof serverFS.useOS => {
    if (!file.startsWith('/__typescript__')) {
      track(path.normalize(file));
    }

    return serverFS.useOS;
  };

  return new API({
    fs: {
      fileExists: probe,
      directoryExists: (directory) => {
        trackDirectory(path.normalize(directory));

        return serverFS.useOS;
      },
      readFile: (file) => {
        probe(file);

        return sources?.get(path.normalize(file)) ?? serverFS.useOS;
      },
      realpath: probe,
      stat: probe,
      // Explicit entries need compiler options, without expanding a config's include globs.
      getAccessibleEntries: () => ({ files: [], directories: [], symlinks: [] }),
      writeFile: serverFS.noop,
      removeFile: serverFS.noop,
    },
  });
}

export function programDiagnostics(program: Program): Diagnostic[] {
  return [
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
}
