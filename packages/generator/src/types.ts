import { mkdir, readFile, writeFile, lstat, readdir, rename, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ensureSchemaPackage } from './schema-package.ts';
import { compileCatalog, indexDtsText, globalsDtsText, TYPES_REVISION } from './schema-types.ts';

export const DEFAULT_TYPES_DIR = '.bedrock-core/generated/mc';

/** Mojang schema selection and generated editor-declaration settings. */
export interface SchemaTypeSettings {
  /** Profile switch controlling editor-declaration generation. */
  types?: boolean;
  /** Mojang schema package version; defaults to latest. */
  schemaVersion?: string;
  /** Declaration directory relative to root; null or omission selects .bedrock-core/generated/mc. */
  typesDir?: string | null;
  /** Prefix applied to generated document type names. */
  typePrefix?: string;
  /** Emit stricter schema-derived types; defaults to false. */
  strict?: boolean;
  /** Maximum latest-version cache age; defaults to 24 hours. */
  maxAgeHours?: number;
}

/** Project directory, cancellation and progress sink for editor-declaration generation. */
export interface SchemaTypeOptions extends SchemaTypeSettings {
  /** Real authored project directory. */
  root: string;
  /** Cooperative fetch/generation cancellation. */
  signal?: AbortSignal;
  /** Schema download and generation progress sink. */
  log?: (message: string) => void;
}

/** Resolved schema package version, declaration directory and change status. */
export interface SchemaTypeResult {
  /** Resolved Mojang schema package version. */
  readonly version: string;
  /** Absolute declaration directory. */
  readonly outputPath: string;
  /** Whether declarations were rewritten. */
  readonly changed: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return false;
  }
}

async function safeDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);

  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Generated schema types need a dedicated directory inside the project');
  }

  let current = root;

  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);

    if (await exists(current) && (await lstat(current)).isSymbolicLink()) {
      throw new Error(`Generated schema directories cannot use symlinks: ${current}`);
    }
  }
}

/**
 * Generate global document aliases and Many from the official cached schemas for the IDE.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns Resolved schema version, absolute declaration directory and whether output changed.
 * @remarks The standalone call generates declarations directly; the profile types switch controls whether the runner invokes it.
 */
export async function generateSchemaTypes(options: SchemaTypeOptions): Promise<SchemaTypeResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(path.resolve(options.root));
  const output = path.resolve(root, options.typesDir || DEFAULT_TYPES_DIR);
  const cacheDir = path.join(root, '.bedrock-core/cache/generator');
  const log = options.log ?? (() => {});

  await safeDirectory(root, output);
  await safeDirectory(root, cacheDir);
  await mkdir(path.dirname(output), { recursive: true });
  const lock = `${output}.builder-types-lock`;

  await mkdir(lock);
  const candidate = `${output}.builder-types-next-${randomUUID()}`;
  const backup = `${output}.builder-types-backup-${randomUUID()}`;
  let moved = false;

  try {
    const schemas = await ensureSchemaPackage({
      version: options.schemaVersion ?? 'latest',
      cacheDir,
      maxAgeHours: options.maxAgeHours ?? 24,
      signal: options.signal,
      log,
    });
    const marker = `${schemas.version} strict=${options.strict ? 1 : 0} prefix=${options.typePrefix ?? ''} rev=${TYPES_REVISION}`;
    const markerFile = path.join(output, '.generated');

    if (await exists(markerFile) && await readFile(markerFile, 'utf8') === marker
      && await exists(path.join(output, 'globals.d.ts')) && await exists(path.join(output, 'index.d.ts'))) {
      return { version: schemas.version, outputPath: output, changed: false };
    }

    if (await exists(output) && !await exists(markerFile) && (await readdir(output)).length) {
      throw new Error(`Refusing to overwrite typesDir with authored content: ${output}`);
    }

    await mkdir(candidate);
    const categories = await compileCatalog({
      pkgRoot: schemas.root,
      outDir: candidate,
      strict: options.strict ?? false,
      typePrefix: options.typePrefix ?? '',
      log,
    });

    options.signal?.throwIfAborted();

    if (!categories.length) {
      throw new Error('No Minecraft schema categories compiled');
    }

    const { formatDeclarations } = await import('./declarations.ts');

    await writeFile(path.join(candidate, 'index.d.ts'), formatDeclarations(indexDtsText(categories, schemas.version)));
    await writeFile(path.join(candidate, 'globals.d.ts'), formatDeclarations(globalsDtsText(categories, options.typePrefix ?? '')));
    await writeFile(path.join(candidate, '.generated'), marker);

    if (await exists(output)) {
      await rename(output, backup);
      moved = true;
    }

    try {
      await rename(candidate, output);
    } catch (error) {
      if (moved) {
        await rename(backup, output);
        moved = false;
      }

      throw error;
    }

    if (moved) {
      await rm(backup, { recursive: true, force: true });
      moved = false;
    }

    log(`Generated ${categories.length} Minecraft document types in ${path.relative(root, output)}`);

    return { version: schemas.version, outputPath: output, changed: true };
  } finally {
    await rm(candidate, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
