import { context as createContext, type Plugin, type Metafile } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
}
export interface BundleResult {
  files: string[];
  inputs: string[];
  metafile: Metafile;
}

/** Bundle one explicit TS/JS entry without requiring the builder or Minecraft runtime libraries. */
export async function bundleScripts(options: BundleOptions): Promise<BundleResult> {
  const root = path.resolve(options.root);
  const outfile = path.resolve(root, options.outfile);
  const aliases = options.aliases ?? {};
  const resolving = Symbol('project-dependency');
  const resolver: Plugin = {
    name: '@bedrock-core/project-imports',
    setup(build) {
      build.onLoad({ filter: /\.screen\.tsx$/ }, () => ({
        errors: [
          {
            text: 'Screen JSX requires the shared UI transform; UI compiler integration is not implemented yet',
          },
        ],
      }));
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (Object.hasOwn(aliases, args.path)) {
          return { path: path.resolve(root, aliases[args.path]) };
        }

        if (args.path.startsWith('@bedrock-core/generated/')) {
          return {
            errors: [
              {
                text: `Missing generated import: ${args.path}; register its producer artifact and configure generatedImports`,
              },
            ],
          };
        }

        if (
          !options.dependencyRoot
          || args.pluginData === resolving
          || args.kind === 'entry-point'
          || args.path.startsWith('.')
          || path.isAbsolute(args.path)
        ) {
          return;
        }

        // Try staged resolution first so tsconfig aliases retain their project-relative meaning.
        const local = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: resolving,
        });

        if (!local.errors.length) {
          return local;
        }

        return build.resolve(args.path, {
          resolveDir: options.dependencyRoot,
          kind: args.kind,
          pluginData: resolving,
        });
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
    platform: 'neutral',
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

    return {
      files: result.outputFiles!.map(file => file.path),
      inputs: Object.keys(result.metafile!.inputs).map(file => path.resolve(root, file)),
      metafile: result.metafile!,
    };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await build.dispose();
  }
}
