import { build, version, type Plugin } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CompilationDependencies } from '@bedrock-core/builder-bundler/dependencies';
import { gameStubPlugin } from './stubs/game.ts';
import { desugarJsxConditionals } from './sugar.ts';

export const uiCompilerVersion = version;
export const libraryModules: Record<string, string> = {
  '@bedrock-core/ui': 'ui',
  '@bedrock-core/ui-runtime': 'ui',
  '@bedrock-core/ui/jsx-runtime': 'jsx',
  '@bedrock-core/ui/jsx-dev-runtime': 'jsx',
  '@bedrock-core/ui-runtime/jsx-runtime': 'jsx',
  '@bedrock-core/ui-runtime/jsx-dev-runtime': 'jsx',
  '@bedrock-core/ui-runtime/compile': 'runtime',
  '@bedrock-core/ui/container': 'container',
  '@bedrock-core/ui-runtime/container': 'container',
  '@bedrock-core/ui/entity': 'entity',
  '@bedrock-core/ui-runtime/entity': 'entity',
  '@bedrock-core/ui-compiler': 'compiler',
  '@bedrock-core/i18n': 'i18n',
};

export interface UiBundleOptions {
  root: string;
  dependencyRoot: string;
  tsconfig?: string;
  aliases?: Record<string, string>;
  source?: string;
  exports?: Record<string, string[]>;
  signal?: AbortSignal;
}

export interface UiBundle {
  code: string;
  inputs: string[];
  cacheable: boolean;
}

/** Bundle the addon's own compiler once, sharing its runtime across screen modules. */
export async function bundleUiLibrary(options: UiBundleOptions): Promise<UiBundle> {
  return bundle(options, `
    import * as ui from '@bedrock-core/ui';
    import * as jsx from '@bedrock-core/ui/jsx-dev-runtime';
    import * as compiler from '@bedrock-core/ui-compiler';
    import * as runtime from '@bedrock-core/ui-runtime/compile';
    import * as container from '@bedrock-core/ui-runtime/container';
    import * as entity from '@bedrock-core/ui-runtime/entity';
    import * as i18n from '@bedrock-core/i18n';
    export { ui, jsx, compiler, runtime, container, entity, i18n };
  `);
}

/** Bundle only the screen and its helpers; toolkit imports share library.mjs. */
export async function bundleUiModule(options: UiBundleOptions & { source: string; exports: Record<string, string[]> }): Promise<UiBundle> {
  return bundle(options, `export { default } from ${JSON.stringify(options.source)}; export * from ${JSON.stringify(options.source)};`);
}

/** Capture tagged app declarations from the actual manifest script entry. */
export async function bundleUiDeclaration(options: UiBundleOptions & { source: string }): Promise<UiBundle> {
  return bundle(options, `
    import { core } from '@bedrock-core/server-runtime';
    let captured;
    const anything = () => new Proxy(function registered() {}, {
      get: (_target, key) => typeof key === 'symbol' ? undefined : anything(),
      apply: () => anything(),
    });
    core.register = options => { captured = options; return anything(); };
    let failure;
    try { await import(${JSON.stringify(options.source)}); }
    catch (error) { failure = error instanceof Error ? error.stack : String(error); }
    export default captured === undefined ? { failure } : { declaration: captured };
  `, true);
}

async function bundle(options: UiBundleOptions, contents: string, declaration = false): Promise<UiBundle> {
  options.signal?.throwIfAborted();
  const dependencies = new CompilationDependencies(options.root, options.tsconfig);
  const resolving = Symbol('ui-resolution');
  const plugins: Plugin[] = [];

  if (!options.exports) {
    plugins.push({
      name: '@bedrock-core/ui-optional-surfaces',
      setup(builder) {
        builder.onResolve({ filter: /^@bedrock-core\/ui-runtime\/(?:container|entity)$/ }, async (args) => {
          if (args.pluginData === resolving) {
            return;
          }

          dependencies.imports(args.path, options.dependencyRoot);
          const resolved = await builder.resolve(args.path, {
            resolveDir: options.dependencyRoot, kind: args.kind, pluginData: resolving,
          });

          return resolved.errors.length ? { path: args.path, namespace: 'ui-optional' } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'ui-optional' }, () => ({ contents: 'export {};', loader: 'js' }));
      },
    });
  }

  if (declaration) {
    plugins.push({
      name: '@bedrock-core/ui-declaration',
      setup(builder) {
        builder.onResolve({ filter: /^@bedrock-core\/generated\/ui$/ }, () => ({ path: 'generated-ui', namespace: 'ui-declaration' }));
        builder.onLoad({ filter: /.*/, namespace: 'ui-declaration' }, () => ({
          contents: 'export const UI_REFERENCE = []; export const SCREEN_KEYS = []; export const UI_NAMESPACE = ""; export const uiReference = () => ({});',
          loader: 'js',
        }));
      },
    });
  }

  if (options.exports) {
    plugins.push({
      name: '@bedrock-core/ui-library',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === './library.mjs') {
            return { path: args.path, external: true };
          }

          const member = Object.hasOwn(libraryModules, args.path) ? libraryModules[args.path] : undefined;

          if (member) {
            return { path: member, namespace: 'ui-library' };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'ui-library' }, args => ({
          contents: [
            `import { ${args.path} as library } from './library.mjs';`,
            ...(options.exports![args.path] ?? []).map((name, index) => `const member${index} = library[${JSON.stringify(name)}]; export { member${index} as ${JSON.stringify(name)} };`),
          ].join('\n'),
          loader: 'js',
        }));
      },
    });
  }

  plugins.push(gameStubPlugin(options.dependencyRoot, dependencies.files), {
    name: '@bedrock-core/ui-inputs',
    setup(builder) {
      builder.onLoad({ filter: /\.screen\.tsx$/ }, async args => ({
        contents: desugarJsxConditionals(await readFile(args.path, 'utf8'), args.path),
        loader: 'tsx',
      }));
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === resolving) {
          return;
        }

        const alias = options.aliases && Object.hasOwn(options.aliases, args.path) ? options.aliases[args.path] : undefined;

        if (alias) {
          dependencies.files.add(alias);

          return { path: alias };
        }

        const shared = args.path.startsWith('@bedrock-core/');
        const primaryDirectory = shared ? options.dependencyRoot : args.resolveDir;
        const fallbackDirectory = shared ? args.resolveDir : options.dependencyRoot;
        const primary = await builder.resolve(args.path, { resolveDir: primaryDirectory, kind: args.kind, pluginData: resolving });
        const resolved = primary.errors.length
          ? await builder.resolve(args.path, { resolveDir: fallbackDirectory, kind: args.kind, pluginData: resolving })
          : primary;

        if (!resolved.external && path.isAbsolute(resolved.path)) {
          const explicitFile = path.isAbsolute(args.path) && /\.(?:tsx?|mts|cts|json)$/.test(args.path);

          if (explicitFile) {
            dependencies.files.add(args.path);
          } else {
            dependencies.imports(args.path, primaryDirectory || options.root);
          }

          if (primary.errors.length) {
            dependencies.imports(args.path, fallbackDirectory || options.root);
          }

          if (/\.(?:mjs|cjs|jsx?|css)$/.test(resolved.path)) {
            dependencies.candidates(resolved.path);
          }
        }

        return resolved;
      });
    },
  });
  const result = await build({
    absWorkingDir: options.root,
    stdin: { contents, resolveDir: options.root, loader: 'ts', sourcefile: 'ui.entry.ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    jsxImportSource: '@bedrock-core/ui',
    ...(options.tsconfig ? { tsconfig: path.resolve(options.root, options.tsconfig) } : {}),
    plugins,
    metafile: true,
    write: false,
    logLevel: 'silent',
    banner: { js: 'import { createRequire as __uiRequire } from "node:module"; const require = __uiRequire(import.meta.url);' },
  });

  options.signal?.throwIfAborted();
  const output = result.outputFiles[0];

  if (!output) {
    throw new Error('@bedrock-core UI bundling produced no output');
  }

  let cacheable = true;

  for (const [file, metadata] of Object.entries(result.metafile!.inputs)) {
    if (file === 'ui.entry.ts' || file.startsWith('ui-library:') || file.startsWith('minecraft-stub:') || file.startsWith('ui-declaration:') || file.startsWith('ui-optional:')) {
      continue;
    }

    const input = path.resolve(options.root, file);

    dependencies.files.add(input);
    dependencies.parents(path.dirname(input));

    if (options.exports) {
      const source = await readFile(input, 'utf8');

      // Node I/O and ambient values cannot be inferred from the static import graph.
      cacheable &&= !metadata.imports.some(item => item.external && !item.path.startsWith('@minecraft/'))
        && !/\b(?:process|Deno|Bun)\s*\.|\bDate\b|\bMath\s*\.\s*random\b/.test(source);
    }
  }

  return { code: output.text, inputs: [...dependencies.files], cacheable };
}
