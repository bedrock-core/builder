import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleScripts, type BundleOptions, type CompiledModule } from '@bedrock-core/builder-bundler';
import { templateCategory } from './category.ts';
import type { JsonValue } from './templates.ts';
import { deterministicData } from './deterministic.ts';
export { defineMany, defineTemplate } from './templates.ts';
export type { JsonValue, ManyTemplate, TemplateName, TemplateData } from './templates.ts';
export { generateSchemaTypes } from './types.ts';
export type { SchemaTypeSettings, SchemaTypeOptions, SchemaTypeResult } from './types.ts';

const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

export interface JsonFormatting {
  indent?: 'tab' | 'space';
  size?: number;
}

export interface GeneratedDocument {
  readonly path: string;
  readonly source: string;
  readonly value: JsonValue;
  readonly content: string;
  readonly category?: string;
}

export interface GeneratorOptions {
  root: string;
  files: readonly string[];
  dependencyRoot?: string;
  aliases?: Record<string, string>;
  tsconfig?: string;
  pretty?: JsonFormatting | false;
  signal?: AbortSignal;
  validate?: (document: GeneratedDocument) => void | Promise<void>;
  /** Optional per-template reuse supplied by a build runner. */
  reuse?: (source: string, evaluate: () => Promise<TemplateEvaluation>) => Promise<TemplateEvaluation>;
  /** Compiler integration supplied by the runner. */
  compile?: (options: BundleOptions) => Promise<CompiledModule>;
}

export interface TemplateEvaluation {
  documents: GeneratedDocument[];
  inputs: string[];
  watchFiles: string[];
  cacheable: boolean;
}

export interface GeneratorResult {
  readonly documents: GeneratedDocument[];
  readonly inputs: string[];
  readonly templates: string[];
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function format(value: unknown, pretty?: JsonFormatting | false): string {
  const tab = pretty && pretty.indent === 'tab';
  const size = pretty ? Math.max(1, Math.trunc(pretty.size ?? (tab ? 1 : 2))) : 0;
  const indent = pretty ? (tab ? '\t' : ' ').repeat(size) : undefined;
  const json = JSON.stringify(value, null, indent);

  if (json === undefined) {
    throw new Error('Template does not produce JSON output');
  }

  return pretty ? `${json}\n` : json;
}

function outputName(name: unknown, source: string): string {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..'
    || /[/\\<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || [...name].some(character => character.charCodeAt(0) < 32)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(`Template filename must be a portable basename: ${String(name)} in ${source}`);
  }

  return name.endsWith('.json') ? name : `${name}.json`;
}

/** Evaluate explicit trusted templates and emit JSON after every template passes validation. */
export async function generateTemplates(options: GeneratorOptions): Promise<GeneratorResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(path.resolve(options.root));
  const templates = [...new Set(options.files.map(file => path.resolve(root, file)))].sort();
  const inputs = new Set<string>(templates);
  const documents = new Map<string, GeneratedDocument>();
  const workspace = await mkdtemp(path.join(tmpdir(), 'bedrock-core-generator-'));
  const originals = new Map<string, Buffer | undefined>();
  const written: string[] = [];

  try {
    function document(source: string, name: unknown, value: unknown, category?: string): GeneratedDocument {
      options.signal?.throwIfAborted();
      const destination = path.join(path.dirname(source), outputName(name, source));
      const content = format(value, options.pretty);
      const generated = { path: destination, source, value: JSON.parse(content) as JsonValue, content, category: category ?? templateCategory(value) };

      return generated;
    }

    for (const source of templates) {
      options.signal?.throwIfAborted();
      const sourceInfo = await lstat(source);

      if (!within(root, source) || !within(root, await realpath(source)) || sourceInfo.isSymbolicLink() || !sourceInfo.isFile()
        || !/\.(?:ts|js|mts|cts|mjs|cjs)$/.test(source) || /\.d\.(?:ts|mts|cts)$/.test(source)) {
        throw new Error(`Template must be a TS/JS source file inside its project: ${source}`);
      }

      const evaluate = async (): Promise<TemplateEvaluation> => {
        const emitted: GeneratedDocument[] = [];
        const id = createHash('sha256').update(path.relative(root, source)).digest('hex');
        const compiled = path.join(workspace, `template-${id}.mjs`);
        const bundle = await (options.compile ?? bundleScripts)({
          root,
          entry: source,
          outfile: compiled,
          dependencyRoot: options.dependencyRoot,
          aliases: options.aliases,
          tsconfig: options.tsconfig,
          platform: 'node',
          inject: [path.join(import.meta.dirname, `templates.${sourceExtension}`)],
          // Bundled CommonJS dependencies can require Node built-ins from this ESM module.
          banner: 'import { createRequire as __bedrockCoreCreateRequire } from \'node:module\'; const require = __bedrockCoreCreateRequire(import.meta.url);',
          debug: true,
          target: 'esnext',
          signal: options.signal,
        });

        const module: Record<string, unknown> = await import(pathToFileURL(compiled).href);

        if (!Object.hasOwn(module, 'default')) {
          throw new Error(`Template must export default JSON data or [name, data, items]: ${source}`);
        }

        const value = module.default;
        const category = templateCategory(value);

        if (Array.isArray(value)) {
          if (value.length !== 3 || typeof value[0] !== 'function' || typeof value[1] !== 'function' || !Array.isArray(value[2])) {
            throw new Error(`Invalid default export array: expected [nameFn, dataFn, items] in ${source}`);
          }

          const [name, data, items] = value as [(item: unknown, index: number) => unknown, (item: unknown, index: number) => unknown, unknown[]];

          for (const [index, item] of items.entries()) {
            options.signal?.throwIfAborted();
            emitted.push(document(source, await name(item, index), await data(item, index), category));
          }
        } else if (value !== null && typeof value === 'object') {
          emitted.push(document(source, path.basename(source, path.extname(source)), value, category));
        } else {
          throw new Error(`Unsupported template: expected a default export object or [nameFn, dataFn, items] in ${source}`);
        }

        const helpers = ['templates', 'category'].map(file => path.join(import.meta.dirname, `${file}.${sourceExtension}`));

        return {
          documents: emitted,
          inputs: bundle.inputs,
          watchFiles: bundle.watchFiles,
          cacheable: !!options.reuse && bundle.cacheable && await deterministicData(bundle.inputs.filter(file => !helpers.includes(file))),
        };
      };

      const result = options.reuse ? await options.reuse(source, evaluate) : await evaluate();

      for (const file of result.inputs) {
        if (!within(workspace, file)) {
          inputs.add(file);
        }
      }

      for (const generated of result.documents) {
        await options.validate?.(generated);
        documents.set(process.platform === 'win32' ? generated.path.toLowerCase() : generated.path, generated);
      }
    }

    for (const document of documents.values()) {
      try {
        const info = await lstat(document.path);

        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Generator output must be a regular JSON file: ${document.path}`);
        }

        originals.set(document.path, await readFile(document.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        originals.set(document.path, undefined);
      }
    }

    for (const document of documents.values()) {
      options.signal?.throwIfAborted();
      await mkdir(path.dirname(document.path), { recursive: true });
      const file = await open(document.path, originals.get(document.path) === undefined ? 'wx' : 'w');

      written.push(document.path);

      try {
        await file.writeFile(document.content);
      } finally {
        await file.close();
      }
    }

    if (options.tsconfig) {
      inputs.add(path.resolve(root, options.tsconfig));
    }

    return { documents: [...documents.values()], inputs: [...inputs], templates };
  } catch (error) {
    for (const file of written.reverse()) {
      const original = originals.get(file);

      if (original === undefined) {
        await rm(file, { force: true });
      } else {
        await writeFile(file, original);
      }
    }

    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
