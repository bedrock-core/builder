import { context as createContext, version, type Plugin, type Metafile } from 'esbuild';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompilationDependencies } from './dependencies.ts';
import { apiImports, type ApiModule } from './api.ts';
import { apiProvider } from './api-provider.ts';
import { nativeAccessSources } from './native-access.ts';

export { apiImports } from './api.ts';
export { emitApiLibrary } from './api-library.ts';

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
  /** Declared external addon APIs whose public exports become Core bindings. */
  moduleNames?: readonly string[];
  /** Internal provider contract selection; consumer API metadata selects this automatically. */
  nativeAccess?: boolean;
  /** Internal checked provider entries whose objects receive generated registration metadata. */
  provides?: readonly ApiModule[];
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
  const virtualInputs = new Set<string>();
  const trackedVirtualInputs = new Set<string>();
  let cacheable = true;
  let requireNativeAccess = options.nativeAccess === true;
  const nativeSources = new Map<string, string>();
  let instrumentedSources = new Map<string, string>();
  const nativeCandidate = options.platform !== 'node' && (requireNativeAccess || options.moduleNames?.some(name => !name.startsWith('@minecraft/')));
  const provider = apiProvider(options.provides ?? [], options.dependencyRoot ?? root, root);

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

        // Runtime bindings and compiled screens belong to the addon's installed
        // instances even when an ordinary dependency has its own package copies.
        const shared = ['@bedrock-core/server', '@bedrock-core/server-runtime', '@bedrock-core/ui-runtime']
          .some(name => args.path === name || args.path.startsWith(`${name}/`))
          || options.resolveFromProject?.some(prefix => args.path.startsWith(prefix));
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

  const trackPlugin = (plugin: Plugin, trusted = false): Plugin => ({
    name: plugin.name,
    setup(build) {
      return plugin.setup({
        ...build,
        onLoad(loadOptions, callback) {
          build.onLoad(loadOptions, async (args) => {
            const loaded = await callback(args);
            const result = loaded && { ...loaded };

            if (args.namespace === 'file' && result?.contents !== undefined && /\.[cm]?[jt]sx?$/.test(args.path)
              && (nativeCandidate || provider.has(args.path))) {
              const file = path.normalize(args.path);
              const contents = provider.transform(file, typeof result.contents === 'string' ? result.contents : Buffer.from(result.contents).toString('utf8'));

              if (nativeCandidate) {
                nativeSources.set(file, contents);
              }

              result.contents = instrumentedSources.get(file) ?? contents;
            }

            track(result);

            if (args.namespace !== 'file' && result) {
              const key = `${args.namespace}:${args.path}`.replaceAll('\\', '/');

              virtualInputs.add(key);

              if ((trusted || options.cachePlugins === true) && result.watchFiles?.length) {
                trackedVirtualInputs.add(key);
              }
            }

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
  });
  const trackedPlugins = (options.plugins ?? []).map(plugin => trackPlugin(plugin));
  const apis = trackPlugin(apiImports(options.moduleNames ?? [], options.platform !== 'node', options.dependencyRoot ?? root,
    file => dependencies.files.add(file), () => { requireNativeAccess = true; }), true);
  const nativeLoader: Plugin = {
    name: '@bedrock-core/native-access',
    setup(build) {
      if (!nativeCandidate && !options.provides?.length) {
        return;
      }

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async (args) => {
        const file = path.normalize(args.path);

        if (!nativeCandidate && !provider.has(file)) {
          return;
        }

        const contents = provider.transform(file, await readFile(file, 'utf8'));

        if (nativeCandidate) {
          nativeSources.set(file, contents);
        }

        return { contents: instrumentedSources.get(file) ?? contents,
          loader: /\.tsx$/.test(file) ? 'tsx' : /\.jsx$/.test(file) ? 'jsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js',
          resolveDir: path.dirname(file), watchFiles: [file] };
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
    external: ['@minecraft/server', '@minecraft/server-*', '@minecraft/debug-utilities', ...(options.external ?? [])],
    ...(options.tsconfig ? { tsconfig: path.resolve(root, options.tsconfig) } : {}),
    plugins: [apis, ...trackedPlugins, nativeLoader, resolver],
  });

  const cancel = () => {
    void build.cancel();
  };

  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    options.signal?.throwIfAborted();
    let result = await build.rebuild();

    if (nativeCandidate && requireNativeAccess) {
      instrumentedSources = nativeAccessSources({ sources: nativeSources, root, dependencyRoot: options.dependencyRoot ?? root,
        aliases, tsconfig: options.tsconfig, track: file => dependencies.files.add(file) });

      if (instrumentedSources.size) {
        result = await build.rebuild();
      }
    }

    options.signal?.throwIfAborted();

    // All compilation finishes before any file is written; unrelated files are retained.
    for (const file of result.outputFiles!) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }

    const inputs: string[] = [];

    for (const file of Object.keys(result.metafile!.inputs)) {
      const key = file.replaceAll('\\', '/');

      if (virtualInputs.has(key)) {
        cacheable &&= trackedVirtualInputs.has(key);
      } else {
        inputs.push(path.resolve(root, file));
      }
    }

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
