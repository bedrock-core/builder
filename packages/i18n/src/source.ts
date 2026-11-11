import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript-native/ast';
import { API } from 'typescript-native/sync';
import { bundleScripts, type BundleOptions } from '@bedrock-core/builder-bundler';
import type { I18nOptions } from './types.ts';

const runtimeModules = new Set(['@bedrock-core/i18n', '@bedrock-core/server/i18n']);

/** Authored creation site and the locale objects captured from its exported instance. */
export interface I18nSource {
  file: string;
  locales: Record<string, unknown>;
  options: { namespace?: string; defaultLocale?: string };
}

function creation(api: API, source: string, file: string): { argument?: { start: number; end: number } } | undefined {
  using parsed = api.createSourceFile(path.resolve(file), source);
  const names = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of parsed.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !runtimeModules.has(statement.moduleSpecifier.text)) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'createI18n') {
          names.add(binding.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }

  const calls: ts.CallExpression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const matches = ts.isIdentifier(callee)
        ? names.has(callee.text)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && namespaces.has(callee.expression.text) && callee.name.text === 'createI18n';

      if (matches) {
        calls.push(node);
      }
    }

    node.forEachChild(visit);
  };

  visit(parsed.sourceFile);

  if (calls.length > 1) {
    throw new Error(`${file}: export one createI18n instance per owning pack`);
  }

  if (calls.length) {
    const argument = calls[0]!.arguments[0];

    return { argument: argument && { start: argument.getStart(), end: argument.end } };
  }
}

function sourceCandidates(entries: readonly string[]): string[] {
  using api = new API();

  return entries.filter(file => creation(api, fs.readFileSync(file, 'utf8'), file));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Detect a pack-owned instance without evaluating its entry module. */
export function hasI18nSource(directory: string): boolean {
  using api = new API();

  return ['ts', 'js', 'mts', 'mjs'].some((extension) => {
    const file = path.join(directory, `index.${extension}`);

    return fs.existsSync(file) && !!creation(api, fs.readFileSync(file, 'utf8'), file);
  });
}

/** Evaluate the authored entry with a pure factory that captures its resource objects. */
export async function loadI18nSource(directory: string, options: I18nOptions, inputs: Set<string>): Promise<I18nSource | undefined> {
  const entries = ['ts', 'js', 'mts', 'mjs'].map(extension => path.join(directory, `index.${extension}`)).filter(file => fs.existsSync(file));
  const candidates = sourceCandidates(entries);

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length > 1) {
    throw new Error(`${directory}: multiple i18n entry modules`);
  }

  const file = candidates[0]!;
  const workspace = await mkdtemp(path.join(tmpdir(), 'bedrock-core-i18n-source-'));
  const plugin: NonNullable<BundleOptions['plugins']>[number] = {
    name: 'bedrock-core-i18n-source',
    setup(build) {
      build.onResolve({ filter: /^@bedrock-core\/(?:i18n|server\/i18n)$/ }, async (args) => {
        if (args.pluginData !== undefined) {
          return;
        }

        const resolved = await build.resolve(args.path, {
          resolveDir: options.dependencyRoot ?? args.resolveDir, kind: args.kind, pluginData: 'i18n-source-real',
        });

        if (resolved.errors.length) {
          return { errors: resolved.errors };
        }

        return { path: resolved.path, namespace: 'i18n-source' };
      });
      build.onLoad({ filter: /.*/, namespace: 'i18n-source' }, args => ({
        contents: `export * from ${JSON.stringify(args.path)}; export const createI18n = (locales, options = {}) => ({ __bedrockCoreI18n: { locales, options } });`,
        loader: 'js',
        resolveDir: path.dirname(args.path),
        watchFiles: [args.path],
      }));
    },
  };

  try {
    const output = path.join(workspace, 'source.mjs');
    const result = await (options.compile ?? bundleScripts)({
      root: path.resolve(options.root), entry: file, outfile: output,
      dependencyRoot: options.dependencyRoot, aliases: options.aliases, tsconfig: options.tsconfig,
      platform: 'node', debug: true, target: 'esnext', signal: options.signal,
      plugins: [plugin], cachePlugins: true, pluginKey: 'i18n-source/2',
      banner: 'import { createRequire as __bedrockCoreCreateRequire } from \'node:module\'; const require = __bedrockCoreCreateRequire(import.meta.url);',
    });

    for (const input of result.inputs) {
      inputs.add(input);
    }

    const module: Record<string, unknown> = await import(pathToFileURL(output).href);
    const instances = Object.values(module).filter(value => record(value) && record(value.__bedrockCoreI18n));
    const unique = [...new Set(instances)];

    if (unique.length !== 1) {
      throw new Error(`${file}: export the createI18n instance as a named or default export`);
    }

    const captured = (unique[0] as { __bedrockCoreI18n: { locales: unknown; options: unknown } }).__bedrockCoreI18n;

    if (!record(captured.locales) || !Object.keys(captured.locales).length || !record(captured.options)) {
      throw new Error(`${file}: createI18n expects a nonempty locale-object map`);
    }

    return { file, locales: captured.locales, options: captured.options };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Bind only the staged creation call to its compiled data; authored sources remain unchanged. */
export function bindI18nSource(file: string, bundle: string): void {
  using api = new API();
  const source = fs.readFileSync(file, 'utf8');
  const argument = creation(api, source, file)?.argument;

  if (!argument) {
    throw new Error(`${file}: createI18n needs locale objects`);
  }

  let name = '__bedrockCoreCompiledI18n';

  while (source.includes(name)) {
    name += '_';
  }

  const relative = path.relative(path.dirname(file), bundle).replaceAll('\\', '/');
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  const prefix = `import ${name} from ${JSON.stringify(specifier)};\n`;

  fs.writeFileSync(file, prefix + source.slice(0, argument.start) + name + source.slice(argument.end));
}
