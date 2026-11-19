import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findNodeAtOffset, getNodePath, parse, parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { validateWithCreatorTools, type CreatorToolsResult, type CreatorToolsValidationOptions } from './creator-tools.ts';
import type { openTypesRelease, TypeSelection } from './types-release.ts';

export type { CreatorToolsDiagnostic, CreatorToolsResult, CreatorToolsValidationOptions } from './creator-tools.ts';

/** Manifest-classified pack directory whose final JSON files are checked. */
export interface ContentPack {
  /** Configured pack ID used in diagnostics. */
  id: string;
  /** Pack directory to inspect. */
  path: string;
  /** Manifest classification used to select applicable document types. */
  kind: 'behavior' | 'resource' | 'other';
}

/** Validation failure located by pack, file and JSON pointer. */
export interface ContentDiagnostic {
  /** Validator that reported the problem. */
  kind?: 'syntax' | 'type' | 'creator-tools';
  /** Configured pack ID. */
  pack: string;
  /** JSON file path relative to the pack directory, using forward slashes. */
  file: string;
  /** JSON pointer identifying the invalid value. */
  pointer: string;
  /** Validation explanation. */
  message: string;
  /** TypeScript diagnostic code for document type errors. */
  code?: number;
}

/** Per-file syntax and document type diagnostics. */
export interface ContentFileResult {
  /** Configured pack ID. */
  pack: string;
  /** Checked JSON path relative to the pack directory, using forward slashes. */
  file: string;
  /** Applied DocumentTypes category when a matching type is available. */
  category?: string;
  /** Syntax and type errors for this file. */
  diagnostics: ContentDiagnostic[];
}

/** Bedrock types release and validation coverage for the checked files. */
export interface ContentValidationResult {
  /** Resolved native types package version, or an empty string when type checking is unavailable or skipped. */
  typesVersion: string;
  /** Reason the types for this target could not be loaded. */
  typesIssue?: string;
  /** Per-file checks and type coverage. */
  files: ContentFileResult[];
  /** Mojang CLI checks when Creator Tools is enabled. */
  creatorTools?: CreatorToolsResult;
}

/** How to handle document type checks. Invalid JSON syntax always fails. */
export type ContentValidationMode = 'strict' | 'warn' | 'skip';

/** Pack selection, installed native types and optional validation reuse. */
export interface ContentValidationOptions extends TypeSelection {
  /** Final pack directories to validate. */
  packs: readonly ContentPack[];
  /** Document type validation mode, defaulting to warn. */
  mode?: ContentValidationMode;
  /** Optional Creator Tools checks on the complete pack set. */
  creatorTools?: CreatorToolsValidationOptions;
  /** Cooperative validation cancellation. */
  signal?: AbortSignal;
  /** Reuse hook keyed by file, declaration dependencies and validator revision. Call validate on a miss. */
  reuse?: (
    file: string,
    dependencies: readonly string[],
    revision: string,
    validate: () => Promise<ContentFileResult>,
  ) => Promise<ContentFileResult>;
}

/** Aggregated pack content failure with structured diagnostics. */
export class ContentValidationError extends Error {
  /** Structured validation failures collected across checked files. */
  readonly diagnostics: readonly ContentDiagnostic[];

  /** Format the supplied structured diagnostics as one validation error. */
  constructor(diagnostics: ContentDiagnostic[]) {
    super(`Invalid pack content:\n${diagnostics.map(issue => `${issue.pack}/${issue.file}${issue.pointer}: ${issue.message}`).join('\n')}`);
    this.name = 'ContentValidationError';
    this.diagnostics = diagnostics;
  }
}

interface DocumentFile {
  pack: string;
  file: string;
  source: string;
  category?: string;
}

type TypesRelease = Awaited<ReturnType<typeof openTypesRelease>>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function documentInputs(category: string, document: unknown, literal: (value: unknown) => string): { category: string; literal: string; controllerOffset: number }[] {
  const root = record(document);
  const entity = category === 'rp/entity' ? record(root?.['minecraft:client_entity']) : undefined;
  const description = record(entity?.description);
  const controllers = description?.render_controllers;
  const batchSize = 256;

  if (!Array.isArray(controllers) || controllers.length <= batchSize) {
    return [{ category, literal: literal(document), controllerOffset: 0 }];
  }

  // This unbounded list has independently typed entries. Slices keep the
  // literal union manageable and preserve the surrounding document context.
  return Array.from({ length: Math.ceil(controllers.length / batchSize) }, (_, index) => {
    const controllerOffset = index * batchSize;
    const slice = controllers.slice(controllerOffset, controllerOffset + batchSize);

    return {
      category, controllerOffset,
      literal: literal({ ...root, 'minecraft:client_entity': { ...entity, description: { ...description, render_controllers: slice } } }),
    };
  });
}

function entityUpgradeDiagnostics(document: unknown, pack: string, file: string): ContentDiagnostic[] {
  const root = record(document);
  const entity = record(root?.['minecraft:entity']);
  const version = record(record(entity?.description)?.entity_version);
  const steps = version?.upgrades;

  if (!Array.isArray(steps)) {
    return [];
  }

  const diagnostics: ContentDiagnostic[] = [];
  const pointer = '/minecraft:entity/description/entity_version';
  const report = (suffix: string, message: string) => diagnostics.push({ kind: 'type', pack, file, pointer: pointer + suffix, message });
  const handlers = record(entity?.upgrades) ?? {};
  const seen = new Set<number>();
  const formatVersion = typeof root?.format_version === 'string' ? /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(root.format_version) : null;

  if (formatVersion) {
    const [, major, minor, patch = '0'] = formatVersion;

    if (Number(major) < 1 || (Number(major) === 1 && (Number(minor) < 26 || (Number(minor) === 26 && Number(patch) < 20)))) {
      report('', 'Entity versioning requires format_version 1.26.20 or later.');
    }
  }

  for (const [index, value] of steps.entries()) {
    const step = record(value);
    const to = step?.upgrade_to;
    const name = step?.name;

    if (typeof to === 'number') {
      if (!Number.isInteger(to) || to < 1 || to > steps.length || seen.has(to)) {
        report(`/upgrades/${index}/upgrade_to`, `Upgrade versions must use each integer from 1 through ${steps.length} exactly once.`);
      }

      seen.add(to);
    }

    if (typeof name === 'string' && (!name.length || !Object.hasOwn(handlers, name))) {
      report(`/upgrades/${index}/name`, 'Upgrade name must identify a handler in minecraft:entity.upgrades.');
    }
  }

  return diagnostics;
}

async function checkBatch(
  entries: readonly DocumentFile[],
  options: ContentValidationOptions,
  types: TypesRelease | undefined,
  revision: string,
): Promise<ContentFileResult[]> {
  if (!entries.length) {
    return [];
  }

  const pending: {
    entry: DocumentFile;
    resolve: (result: ContentFileResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const lookup = entries.map((entry) => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    const collect = () => new Promise<ContentFileResult>((resolve, reject) => {
      pending.push({ entry, resolve, reject });
      markReady();
    });

    const { pack, file, source, category } = entry;
    const cached = Promise.resolve().then(() => options.reuse
      ? options.reuse(source, category ? types!.inputs : [],
          createHash('sha256').update(JSON.stringify([revision, pack, file, category ?? null])).digest('hex'), collect)
      : collect()).finally(markReady);

    return { ready, cached };
  });
  const settled = Promise.allSettled(lookup.map(entry => entry.cached));

  // Wait for cache hits and collect all misses before checking the batch.
  await Promise.all(lookup.map(entry => entry.ready));

  try {
    const parsed = await Promise.all(pending.map(async ({ entry: { pack, file, source, category } }) => {
      options.signal?.throwIfAborted();
      const errors: ParseError[] = [];
      const document: unknown = parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
      const diagnostics: ContentDiagnostic[] = errors.map(error => ({
        kind: 'syntax',
        pack,
        file,
        pointer: '',
        message: `${printParseErrorCode(error.error)} at offset ${error.offset}`,
      }));
      const result: ContentFileResult = { pack, file, diagnostics };

      if (types && category && !errors.length) {
        result.category = category;

        if (category === 'bp/entities') {
          diagnostics.push(...entityUpgradeDiagnostics(document, pack, file));
        }

        return { result, inputs: documentInputs(category, document, types.literal) };
      }

      return { result };
    }));
    const typed = parsed.flatMap(({ result, inputs }) => inputs?.map(input => ({ result, input })) ?? []);
    const findings = types?.check(typed.map(entry => entry.input), options.signal) ?? [];

    for (const [index, { result, input }] of typed.entries()) {
      const issues = findings[index];

      if (issues.length) {
        const tree = parseTree(input.literal);

        for (const { code, message, offset } of issues) {
          const node = tree && offset >= 0 ? findNodeAtOffset(tree, offset, true) : undefined;
          const segments = node ? getNodePath(node) : [];

          if (input.controllerOffset && segments[0] === 'minecraft:client_entity' && segments[1] === 'description' && segments[2] === 'render_controllers' && typeof segments[3] === 'number') {
            segments[3] += input.controllerOffset;
          }

          const pointer = segments.map(segment => '/' + String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('');
          const formatted = `TS${code} ${message}`;

          if (!input.controllerOffset || !result.diagnostics.some(issue => issue.code === code && issue.pointer === pointer && issue.message === formatted)) {
            result.diagnostics.push({ kind: 'type', code, pack: result.pack, file: result.file, pointer, message: formatted });
          }
        }
      }
    }

    for (const [index, { resolve }] of pending.entries()) {
      resolve(parsed[index].result);
    }
  } catch (error) {
    for (const { reject } of pending) {
      reject(error);
    }
  }

  return (await settled).map((entry) => {
    if (entry.status === 'rejected') {
      throw entry.reason;
    }

    return entry.value;
  });
}

/** Check final pack JSON syntax and the native document types for its Bedrock target. */
export async function validatePackContent(options: ContentValidationOptions): Promise<ContentValidationResult> {
  const mode = options.mode ?? 'warn';
  const backend = mode === 'skip' ? undefined : await import('./types-release.ts');

  using api = backend && new backend.API();
  let types: TypesRelease | undefined;
  let typesIssue: string | undefined;

  if (backend && api) {
    try {
      types = await backend.openTypesRelease(api, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      typesIssue = error instanceof Error ? error.message : String(error);
    }
  }

  const implementation = [new URL(import.meta.url), ...(backend?.typeImplementation ?? [])];
  const revision = options.reuse
    ? createHash('sha256').update(backend?.checkerVersion ?? '').update(Buffer.concat(await Promise.all(implementation.map(file => readFile(file))))).digest('hex')
    : '';
  const files: ContentFileResult[] = [];
  const batch: DocumentFile[] = [];

  for (const pack of options.packs) {
    const root = await realpath(pack.path);

    async function visit(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        options.signal?.throwIfAborted();
        const source = path.join(directory, entry.name);
        const file = path.relative(root, source).replaceAll('\\', '/');

        if (entry.isSymbolicLink()) {
          throw new Error(`Pack content cannot use links: ${pack.id}/${file}`);
        }

        if (entry.isDirectory()) {
          await visit(source);
        } else if (entry.isFile() && /\.json$/i.test(entry.name) && file !== 'manifest.json') {
          batch.push({ pack: pack.id, file, source, category: types?.category(pack.kind, file) });

          if (batch.length === 128) {
            files.push(...await checkBatch(batch.splice(0), options, types, revision));
          }
        }
      }
    }

    await visit(root);
  }

  files.push(...await checkBatch(batch, options, types, revision));
  const diagnostics = files.flatMap(file => file.diagnostics).filter(issue => mode !== 'warn' || issue.kind !== 'type');

  if (typesIssue && mode === 'strict') {
    diagnostics.push({ kind: 'type', pack: 'project', file: '', pointer: '', message: typesIssue });
  }

  if (diagnostics.length) {
    throw new ContentValidationError(diagnostics);
  }

  const result: ContentValidationResult = { typesVersion: types?.version ?? '', files, ...(typesIssue ? { typesIssue } : {}) };

  if (options.creatorTools) {
    const creatorToolsOptions = { projectRoot: options.projectRoot, ...options.creatorTools };

    result.creatorTools = await validateWithCreatorTools(options.packs, creatorToolsOptions, options.signal);
    const errors = result.creatorTools.diagnostics.filter(issue => issue.severity === 'error');

    if (creatorToolsOptions.mode === 'strict' && errors.length) {
      throw new ContentValidationError(errors);
    }
  }

  return result;
}
