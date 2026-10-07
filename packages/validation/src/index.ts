import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import picomatch from 'picomatch';

export interface ContentPack {
  id: string;
  path: string;
  kind: 'behavior' | 'resource' | 'other';
}

export interface ContentDiagnostic {
  pack: string;
  file: string;
  pointer: string;
  message: string;
}

export interface ContentFileResult {
  pack: string;
  file: string;
  schema?: string;
  schemaIssue?: string;
  diagnostics: ContentDiagnostic[];
}

export interface ContentValidationResult {
  schemaVersion: string;
  files: ContentFileResult[];
}

export interface ContentValidationOptions {
  packs: readonly ContentPack[];
  schemaRoot?: string;
  signal?: AbortSignal;
  reuse?: (
    file: string,
    dependencies: readonly string[],
    revision: string,
    validate: () => Promise<ContentFileResult>,
  ) => Promise<ContentFileResult>;
}

export class ContentValidationError extends Error {
  readonly diagnostics: readonly ContentDiagnostic[];

  constructor(diagnostics: ContentDiagnostic[]) {
    super(`Invalid pack content:\n${diagnostics.map(issue => `${issue.pack}/${issue.file}${issue.pointer}: ${issue.message}`).join('\n')}`);
    this.name = 'ContentValidationError';
    this.diagnostics = diagnostics;
  }
}

interface CatalogEntry {
  url: string;
  fileMatch?: string[];
}

interface SchemaDocument {
  [key: string]: unknown;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Validate every JSON document; catalog matches additionally receive schema checks. */
export async function validatePackContent(options: ContentValidationOptions): Promise<ContentValidationResult> {
  const require = createRequire(import.meta.url);
  const root = await realpath(options.schemaRoot ?? path.dirname(require.resolve('@minecraft/bedrock-schemas/catalog.json')));
  const catalogFile = path.join(root, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8')) as { schemas: CatalogEntry[] };
  const metadataFile = path.join(root, 'package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as { version: string };
  const validators = new Map<string, { validate: ValidateFunction; inputs: string[] }>();
  const unavailable = new Map<string, string>();
  const documents = new Map<string, SchemaDocument>();
  const referencesByFile = new Map<string, Set<string>>();
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, logger: false });

  async function load(file: string, inputs: Set<string>): Promise<SchemaDocument> {
    options.signal?.throwIfAborted();
    file = await realpath(file);

    if (!within(root, file)) {
      throw new Error(`Schema reference must stay inside its package: ${file}`);
    }

    inputs.add(file);
    const previous = documents.get(file);

    if (previous) {
      for (const reference of referencesByFile.get(file) ?? []) {
        if (!inputs.has(reference)) {
          await load(reference, inputs);
        }
      }

      return previous;
    }

    const document = JSON.parse(await readFile(file, 'utf8')) as SchemaDocument;
    const references = new Set<string>();

    function normalize(value: unknown): void {
      if (Array.isArray(value)) {
        value.forEach(normalize);
      } else if (value && typeof value === 'object') {
        const node = value as SchemaDocument;

        delete node.$id;

        if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) {
          const target = new URL(node.$ref, pathToFileURL(file));

          if (target.protocol !== 'file:') {
            throw new Error(`Remote schema references are unsupported: ${target.href}`);
          }

          node.$ref = target.href;
          target.hash = '';
          references.add(fileURLToPath(target));
        }

        Object.values(node).forEach(normalize);
      }
    }

    normalize(document);
    document.$id = pathToFileURL(file).href;
    documents.set(file, document);
    referencesByFile.set(file, references);

    for (const reference of references) {
      await load(reference, inputs);
    }

    return document;
  }

  async function validator(file: string) {
    const previous = validators.get(file);

    if (previous) {
      return previous;
    }

    const inputs = new Set([catalogFile, metadataFile]);
    const document = await load(file, inputs);

    for (const schema of documents.values()) {
      // Register the complete graph before compiling cyclic or shared references.
      if (!ajv.schemas[schema.$id as string]) {
        ajv.addSchema(schema);
      }
    }

    const validate = ajv.getSchema(document.$id as string) ?? ajv.compile(document);
    const result = { validate, inputs: [...inputs] };

    validators.set(file, result);

    return result;
  }

  const revision = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  const files: ContentFileResult[] = [];

  for (const pack of options.packs) {
    const packRoot = await realpath(pack.path);
    const prefix = pack.kind === 'behavior' ? 'bp/' : pack.kind === 'resource' ? 'rp/' : undefined;
    const entries = prefix ? catalog.schemas.filter(entry => entry.url.startsWith(`./schemas/${prefix}`)) : [];

    async function visit(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        options.signal?.throwIfAborted();
        const source = path.join(directory, entry.name);
        const relative = path.relative(packRoot, source).replaceAll('\\', '/');

        if (entry.isSymbolicLink()) {
          throw new Error(`Pack content cannot use links: ${pack.id}/${relative}`);
        }

        if (entry.isDirectory()) {
          await visit(source);
          continue;
        }

        if (!entry.isFile() || !/\.json$/i.test(entry.name) || relative === 'manifest.json') {
          continue;
        }

        // Exact filenames take precedence over folder-wide catalog patterns.
        const matches = entries.filter(item => item.fileMatch?.some(pattern => picomatch.isMatch(relative, pattern)));

        matches.sort((a, b) => (a.fileMatch?.join().includes('/**/') ? 1 : 0) - (b.fileMatch?.join().includes('/**/') ? 1 : 0));
        const selected = matches[0];
        let compiled: { validate: ValidateFunction; inputs: string[] } | undefined;
        let schemaIssue = selected ? unavailable.get(selected.url) : undefined;

        if (pack.kind === 'resource' && relative === 'texts/languages.json') {
          const file = fileURLToPath(new URL('../schemas/languages.schema.json', import.meta.url));

          compiled = { validate: ajv.compile(JSON.parse(await readFile(file, 'utf8'))), inputs: [file, catalogFile, metadataFile] };
        } else if (selected && !schemaIssue) {
          try {
            compiled = await validator(path.resolve(root, selected.url));
          } catch (error) {
            options.signal?.throwIfAborted();
            // A broken upstream schema cannot establish content validity.
            schemaIssue = `Schema unavailable: ${error instanceof Error ? error.message : String(error)}`;
            unavailable.set(selected.url, schemaIssue);
          }
        }

        const inputs = compiled?.inputs ?? [catalogFile, metadataFile];

        async function check(): Promise<ContentFileResult> {
          const errors: ParseError[] = [];
          const document: unknown = parse(await readFile(source, 'utf8'), errors, { allowTrailingComma: true });
          const diagnostics: ContentDiagnostic[] = errors.map(error => ({
            pack: pack.id,
            file: relative,
            pointer: '',
            message: `${printParseErrorCode(error.error)} at offset ${error.offset}`,
          }));

          if (!errors.length && compiled && !compiled.validate(document)) {
            for (const error of compiled.validate.errors ?? []) {
              diagnostics.push({ pack: pack.id, file: relative, pointer: error.instancePath, message: error.message ?? error.keyword });
            }
          }

          return {
            pack: pack.id,
            file: relative,
            ...(compiled && selected ? { schema: selected.url } : {}),
            ...(schemaIssue ? { schemaIssue } : {}),
            diagnostics,
          };
        }

        const fileRevision = createHash('sha256').update(JSON.stringify({ revision, pack: pack.id, relative, schema: selected?.url, schemaIssue })).digest('hex');

        files.push(await (options.reuse?.(source, inputs, fileRevision, check) ?? check()));
      }
    }

    await visit(packRoot);
  }

  const diagnostics = files.flatMap(file => file.diagnostics);

  if (diagnostics.length) {
    throw new ContentValidationError(diagnostics);
  }

  return { schemaVersion: metadata.version, files };
}
