import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrateRegolithConfig } from '../migrate.ts';
import { readManifest } from '../manifest.ts';
import { inspectPack } from '../packs.ts';
import { resolveExportPaths } from '../export.ts';
import { stages } from '../plan.ts';
import { validateConfig } from '../config.ts';
import type { FilterKind, MigrationOptions, MigrationResult } from './types.ts';
import { isRecord, pointer } from './types.ts';

/** Configuration preview tied to an authored config path and its original text. */
export interface ProjectMigration extends MigrationResult {
  /** Absolute authored configuration path. */
  configPath: string;
  /** Original bytes decoded as text; guarded writes reject any intervening source edit. */
  sourceText: string;
}

/**
 * Inspect pack metadata and known local wrappers without importing any project code.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns A preview with inspected metadata and the original config text for guarded writes.
 * @remarks Inspects source manifests and known local wrapper identities without importing authored filter code.
 */
export async function migrateRegolithProject(configPath = 'config.json', options: MigrationOptions = {}): Promise<ProjectMigration> {
  const file = await realpath(configPath);
  const project = path.dirname(file);
  const sourceText = await readFile(file, 'utf8');
  const input: unknown = JSON.parse(sourceText);
  const inferred = { ...options, filters: { ...options.filters }, packKinds: { ...options.packKinds } };
  const diagnostics: MigrationResult['diagnostics'] = [];
  const engineVersions = new Set<string>();
  const identities = new Set<string>();

  if (isRecord(input) && isRecord(input.packs)) {
    for (const [id, directory] of Object.entries(input.packs)) {
      if (typeof directory !== 'string') {
        continue;
      }

      const packPath = path.resolve(project, directory);
      const relative = path.relative(project, packPath);

      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        diagnostics.push({ severity: 'error', code: 'pack-location', path: `/packs/${pointer(id)}`, message: 'Pack sources must be directories inside the project.' });
        continue;
      }

      try {
        const manifest = await readManifest(id, packPath);

        inferred.packKinds[id] = (await inspectPack(id, packPath)).kind;

        for (const uuid of [manifest.header.uuid, ...manifest.modules.map(module => module.uuid)]) {
          if (identities.has(uuid.toLowerCase())) {
            diagnostics.push({ severity: 'error', code: 'manifest-identity', path: `/packs/${pointer(id)}`, message: `Manifest UUID ${uuid} is repeated. Pack and module UUIDs must be unique.` });
          }

          identities.add(uuid.toLowerCase());
        }

        if (manifest.header.min_engine_version) {
          engineVersions.add(manifest.header.min_engine_version);
        }
      } catch (error) {
        diagnostics.push({ severity: 'error', code: 'pack-manifest', path: `/packs/${pointer(id)}`, message: `${error instanceof Error ? error.message : String(error)}. Migration only changes config; pack manifests must already use v3.` });
      }
    }

    if (inferred.targetVersion === undefined && input.targetVersion === undefined && engineVersions.size === 1) {
      inferred.targetVersion = [...engineVersions][0];
    }
  }

  if (isRecord(input) && isRecord(input.regolith) && isRecord(input.regolith.filterDefinitions)) {
    const repository = fileURLToPath(new URL('../../', import.meta.url));

    for (const [id, definition] of Object.entries(input.regolith.filterDefinitions)) {
      if (Object.hasOwn(inferred.filters, id) || !isRecord(definition) || definition.runWith !== 'nodejs' || typeof definition.script !== 'string') {
        continue;
      }

      try {
        const script = await realpath(path.resolve(project, definition.script));

        for (const stage of ['core', ...stages] as FilterKind[]) {
          const expected = await realpath(path.join(repository, '..', 'regolith-filters', stage, 'main.ts'));

          if (path.relative(expected, script) === '') {
            Object.defineProperty(inferred.filters, id, { value: stage, enumerable: true });
            break;
          }
        }
      } catch {
        // Unverified modules remain custom filters; the converter reports them.
      }
    }
  }

  inferred.schema ??= path.relative(project, fileURLToPath(new URL('../../schemas/config.schema.json', import.meta.url))).replaceAll('\\', '/');
  const result = migrateRegolithConfig(input, inferred);

  if (isRecord(result.config.packs) && isRecord(result.config.bedrockCore) && isRecord(result.config.bedrockCore.profiles)) {
    for (const [name, profile] of Object.entries(result.config.bedrockCore.profiles)) {
      if (!isRecord(profile) || !isRecord(profile.export)) {
        continue;
      }

      try {
        resolveExportPaths(project, result.config.packs as Record<string, string>, profile.export as Record<string, string>);
      } catch (error) {
        diagnostics.push({ severity: 'error', code: 'export-destinations', path: `/bedrockCore/profiles/${pointer(name)}/export`, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  result.diagnostics.push(...diagnostics);
  result.ready = !result.diagnostics.some(item => item.severity === 'error');

  return { ...result, configPath: file, sourceText };
}

/**
 * Write only complete migrations, retaining an exclusive backup for an in-place edit.
 * @param outputPath Destination config path; defaults to the previewed source config.
 * @returns The written configuration path and an optional in-place backup path.
 * @remarks Requires a ready preview. In-place writes retain a backup and reject changes to the original config after inspection.
 */
export async function writeMigration(result: ProjectMigration, outputPath = result.configPath): Promise<{ path: string; backup?: string }> {
  if (!result.ready || result.diagnostics.some(item => item.severity === 'error')) {
    throw new Error('Migration has unresolved errors; configuration was not written');
  }

  validateConfig(result.config);

  const originalDirectory = path.dirname(result.configPath);
  const destination = path.resolve(originalDirectory, outputPath);
  const destinationDirectory = await realpath(path.dirname(destination));

  if (path.relative(originalDirectory, destinationDirectory) !== '') {
    throw new Error('Write the migrated config beside the original so project-relative paths retain their meaning');
  }

  if (await readFile(result.configPath, 'utf8') !== result.sourceText) {
    throw new Error('Source configuration changed after inspection; preview the migration again');
  }

  const text = `${JSON.stringify(result.config, null, 2)}\n`;

  if (path.relative(result.configPath, destination) !== '') {
    await writeFile(destination, text, { flag: 'wx' });

    return { path: destination };
  }

  if ((await lstat(destination)).isSymbolicLink()) {
    throw new Error('Configuration must be a regular file');
  }

  const backup = `${destination}.regolith.bak`;
  const temporary = `${destination}.builder-${randomUUID()}.tmp`;

  await writeFile(backup, result.sourceText, { flag: 'wx' });

  try {
    await writeFile(temporary, text, { flag: 'wx' });

    if (await readFile(destination, 'utf8') !== result.sourceText) {
      throw new Error('Source configuration changed before replacement; backup retained');
    }

    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }

  return { path: destination, backup };
}
