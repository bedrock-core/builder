import { context as createContext, version, type Plugin, type Metafile } from 'esbuild';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompilationDependencies } from './dependencies.ts';

/** esbuild version used by the standalone bundler and compilation cache. */
export const compilerVersion = version;

/** Explicit script entry, output and module-resolution settings. */
export interface BundleOptions {
  /** Working directory for entry, output and compiler paths. */
  root: string;
  /** Explicit TS/JS entry path relative to root, or absolute. */
  entry: string;
  /** Output JavaScript path relative to root, or absolute. */
  outfile: string;
  /** Fallback authored directory for package resolution. */
  dependencyRoot?: string;
  /** Emit an external source map and retain readable output. */
  debug?: boolean;
  /** esbuild language target; defaults to es2020. */
  target?: string;
  /** TypeScript configuration file for module resolution. */
  tsconfig?: string;
  /** Additional package specifiers retained as runtime imports. */
  external?: string[];
  /** Import specifiers mapped to explicit files. */
  aliases?: Record<string, string>;
  /** Cooperative compiler cancellation. */
  signal?: AbortSignal;
  /** Module platform; defaults to neutral. */
  platform?: 'neutral' | 'node';
  /** JavaScript prepended to the output. */
  banner?: string;
  /** Helper modules injected into compilation. */
  inject?: string[];
  /** Package supplying the automatic JSX runtime. */
  jsxImportSource?: string;
  /** Feature-owned esbuild plugins, applied before the standard resolver. */
  plugins?: readonly Plugin[];
  /** Fingerprint of plugin implementations and settings for compiler reuse. */
  pluginKey?: unknown;
  /** Additional dependencies used by compiler plugins. */
  pluginInputs?: readonly string[];
  /** Opt into reuse when all plugin inputs are tracked; defaults to false. */
  cachePlugins?: boolean;
  /** Import prefixes resolved from dependencyRoot before source-relative lookup. */
  resolveFromProject?: readonly string[];
}
/** Written output files, input dependencies and esbuild compilation metadata. */
export interface BundleResult {
  /** Absolute paths of written bundles and source maps. */
  files: string[];
  /** Existing files consumed by esbuild. */
  inputs: string[];
  /** esbuild input/output metadata. */
  metafile: Metafile;
  /** Resolution candidates include missing files that could shadow an import. */
  watchFiles: string[];
  /** Directories observed by custom compiler plugins; register them for watch rebuilds. */
  watchDirs: string[];
  /** Whether module-resolution dependencies allow safe reuse. */
  cacheable: boolean;
}
/** Compiler output and dependency records accepted by stage integrations. */
export type CompiledModule = Pick<BundleResult, 'files' | 'inputs' | 'watchFiles' | 'cacheable'>;

/**
 * Bundle one explicit TS/JS entry without requiring the builder or Minecraft runtime libraries.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns Written bundle paths, source inputs, resolution candidates and esbuild metadata.
 */
export async function bundleScripts(options: BundleOptions): Promise<BundleResult> {
  const root = path.resolve(options.root);
  const outfile = path.resolve(root, options.outfile);
  const aliases = options.aliases ?? {};
  const resolving = Symbol('project-dependency');
  const dependencies = new CompilationDependencies(root, options.tsconfig);
  const watchDirs = new Set<string>();
  let cacheable = true;

  const resolver: Plugin = {
    name: '@bedrock-core/project-imports',
    setup(build) {
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
        const shared = options.resolveFromProject?.some(prefix => args.path.startsWith(prefix));
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

  function track(result: { watchFiles?: string[]; watchDirs?: string[] } | null | undefined): void {
    for (const file of result?.watchFiles ?? []) {
      dependencies.files.add(path.resolve(root, file));
    }

    // Directory contents need a loader-specific fingerprint to permit reuse.
    if (result?.watchDirs?.length) {
      cacheable = false;

      for (const directory of result.watchDirs) {
        watchDirs.add(path.resolve(root, directory));
      }
    }
  }

  const trackedPlugins: Plugin[] = (options.plugins ?? []).map(plugin => ({
    name: plugin.name,
    setup(build) {
      return plugin.setup({
        ...build,
        onLoad(options, callback) {
          build.onLoad(options, async (args) => {
            const result = await callback(args);

            track(result);

            return result;
          });
        },
        onResolve(options, callback) {
          build.onResolve(options, async (args) => {
            const result = await callback(args);

            track(result);

            return result;
          });
        },
      });
    },
  }));

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
    plugins: [...trackedPlugins, resolver],
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
      watchDirs: [...watchDirs],
      cacheable,
    };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await build.dispose();
  }
}
