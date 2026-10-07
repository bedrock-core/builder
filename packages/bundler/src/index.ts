import { context as createContext, version, type Plugin, type Metafile } from 'esbuild';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompilationDependencies } from './dependencies.ts';

export const compilerVersion = version;

export interface BundleOptions {
  root: string;
  entry: string;
  outfile: string;
  dependencyRoot?: string;
  debug?: boolean;
  target?: string;
  tsconfig?: string;
  external?: string[];
  aliases?: Record<string, string>;
  signal?: AbortSignal;
  platform?: 'neutral' | 'node';
  banner?: string;
  inject?: string[];
  jsxImportSource?: string;
  transformScreen?: (source: string, file: string) => string;
  projectModules?: boolean;
}
export interface BundleResult {
  files: string[];
  inputs: string[];
  metafile: Metafile;
  /** Resolution candidates include missing files that could shadow an import. */
  watchFiles: string[];
  cacheable: boolean;
}
export type CompiledModule = Pick<BundleResult, 'files' | 'inputs' | 'watchFiles' | 'cacheable'>;

/** Bundle one explicit TS/JS entry without requiring the builder or Minecraft runtime libraries. */
export async function bundleScripts(options: BundleOptions): Promise<BundleResult> {
  const root = path.resolve(options.root);
  const outfile = path.resolve(root, options.outfile);
  const aliases = options.aliases ?? {};
  const resolving = Symbol('project-dependency');
  const dependencies = new CompilationDependencies(root, options.tsconfig);
  let cacheable = true;

  const resolver: Plugin = {
    name: '@bedrock-core/project-imports',
    setup(build) {
      build.onLoad({ filter: /\.screen\.tsx$/ }, async args => options.transformScreen
        ? {
            contents: options.transformScreen(await readFile(args.path, 'utf8'), args.path),
            loader: 'tsx',
          }
        : ({
            errors: [
              {
                text: 'Screen JSX requires the UI compiler stage or an explicit screen transform',
              },
            ],
          }));
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === resolving) {
          return;
        }

        if (Object.hasOwn(aliases, args.path)) {
          const file = path.resolve(root, aliases[args.path]);

          dependencies.candidates(file);

          return { path: file };
        }

        if (args.path.startsWith('@bedrock-core/generated/')) {
          return {
            errors: [
              {
                text: `Missing generated import: ${args.path}; enable its producing stage or provide an explicit alias`,
              },
            ],
          };
        }

        // Linked UI libraries share the addon's toolkit instances. Other imports
        // retain source-relative resolution, including staged tsconfig aliases.
        const shared = options.projectModules && args.path.startsWith('@bedrock-core/');
        const primaryDirectory = shared ? options.dependencyRoot ?? root : args.resolveDir;
        const fallbackDirectory = shared ? args.resolveDir : options.dependencyRoot ?? root;
        const local = await build.resolve(args.path, {
          resolveDir: primaryDirectory,
          kind: args.kind,
          pluginData: resolving,
        });

        const resolved = !local.errors.length || !options.dependencyRoot
          ? local
          : await build.resolve(args.path, {
              resolveDir: fallbackDirectory,
              kind: args.kind,
              pluginData: resolving,
            });

        if (!resolved.external && path.isAbsolute(resolved.path)) {
          dependencies.imports(args.path, args.resolveDir || root);

          if (options.dependencyRoot) {
            dependencies.imports(args.path, options.dependencyRoot);
          }

          for (const directory of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) {
            dependencies.candidates(path.resolve(directory, args.path));
          }

          dependencies.candidates(resolved.path);
        }

        return resolved;
      });
    },
  };

  options.signal?.throwIfAborted();
  const build = await createContext({
    absWorkingDir: root,
    entryPoints: [options.entry],
    outfile,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: options.platform ?? 'neutral',
    ...(options.jsxImportSource ? { jsx: 'automatic', jsxImportSource: options.jsxImportSource } as const : {}),
    banner: options.banner ? { js: options.banner } : undefined,
    inject: options.inject?.map(file => path.resolve(root, file)),
    mainFields: ['module', 'main'],
    target: options.target ?? 'es2020',
    minify: !options.debug,
    sourcemap: options.debug ? 'external' : false,
    keepNames: options.debug ?? false,
    logLevel: 'silent',
    external: ['@minecraft/*', ...(options.external ?? [])],
    ...(options.tsconfig ? { tsconfig: path.resolve(root, options.tsconfig) } : {}),
    plugins: [resolver],
  });

  const cancel = () => {
    void build.cancel();
  };

  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    options.signal?.throwIfAborted();
    const result = await build.rebuild();

    options.signal?.throwIfAborted();

    // All compilation finishes before any file is written; unrelated files are retained.
    for (const file of result.outputFiles!) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }

    const inputs = Object.keys(result.metafile!.inputs).map(file => path.resolve(root, file));

    for (const input of inputs) {
      dependencies.parents(path.dirname(input));

      try {
        if (!(await stat(input)).isFile()) {
          cacheable = false;
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }

        // Virtual package files need their loader's own dependency tracking.
        cacheable = false;
      }
    }

    return {
      files: result.outputFiles!.map(file => file.path),
      inputs,
      metafile: result.metafile!,
      watchFiles: [...dependencies.files],
      cacheable,
    };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await build.dispose();
  }
}
