import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

interface ManifestModule {
  type: string;
  uuid: string;
  version: string;
  language?: string;
  entry?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface ManifestOverrides {
  header?: JsonObject;
  metadata?: JsonObject;
  dependencies?: JsonValue[];
  modules?: Record<string, JsonObject>;
  scriptEntry?: string;
}

function mergeObjects(original: JsonObject, overrides: JsonObject): JsonObject {
  const keys = new Set([...Object.keys(original), ...Object.keys(overrides)]);

  return Object.fromEntries([...keys].map((key) => {
    const previous = original[key];
    const next = overrides[key];

    if (!Object.hasOwn(overrides, key)) {
      return [key, structuredClone(previous)];
    }

    return [key, isRecord(previous) && isRecord(next)
      ? mergeObjects(previous as JsonObject, next as JsonObject)
      : structuredClone(next)];
  }));
}

/** Apply profile overrides while retaining unrelated manifest fields and module identities. */
export function transformManifest(input: unknown, overrides: ManifestOverrides): JsonObject {
  if (!isRecord(input) || input.format_version !== 3 || !Array.isArray(input.modules)) {
    throw new Error('Manifest stage requires a v3 manifest with modules');
  }

  const manifest = structuredClone(input) as JsonObject;

  for (const field of ['header', 'metadata'] as const) {
    if (overrides[field]) {
      manifest[field] = mergeObjects(isRecord(manifest[field]) ? manifest[field] as JsonObject : {}, overrides[field]);
    }
  }

  if (overrides.dependencies) {
    manifest.dependencies = structuredClone(overrides.dependencies);
  }

  const modules = manifest.modules as JsonObject[];

  for (const [uuid, patch] of Object.entries(overrides.modules ?? {})) {
    const index = modules.findIndex(module => typeof module.uuid === 'string' && module.uuid.toLowerCase() === uuid.toLowerCase());

    if (index < 0) {
      throw new Error(`Manifest module override refers to unknown UUID: ${uuid}`);
    }

    modules[index] = mergeObjects(modules[index], patch);
  }

  if (overrides.scriptEntry) {
    const scripts = modules.filter(module => module.type === 'script');

    if (scripts.length !== 1) {
      throw new Error('manifest.scriptEntry requires exactly one script module; use module UUID overrides otherwise');
    }

    scripts[0].entry = overrides.scriptEntry;
  }

  return manifest;
}

interface Manifest {
  format_version: 3;
  header: {
    name: string;
    description: string;
    uuid: string;
    version: string;
    min_engine_version?: string;
  };
  modules: ManifestModule[];
}

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function isVersion(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);

  if (!match) {
    return false;
  }

  return !match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readManifest(id: string, directory: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));

  function fail(field: string): never {
    throw new Error(`Pack ${id} has invalid manifest.${field}`);
  }

  if (!isRecord(value) || value.format_version !== 3) {
    fail('format_version; supported format is 3');
  }

  const manifest = value;
  const header = manifest.header;

  if (!isRecord(header)) {
    fail('header');
  }

  const fields = header;

  for (const field of ['name', 'description']) {
    if (typeof fields[field] !== 'string' || (field === 'name' && !fields[field].trim())) {
      fail(`header.${field}`);
    }
  }

  if (typeof fields.uuid !== 'string' || !uuidPattern.test(fields.uuid)) {
    fail('header.uuid');
  }

  if (!isVersion(fields.version)) {
    fail('header.version');
  }

  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    fail('modules');
  }

  for (const [index, module] of manifest.modules.entries()) {
    if (!isRecord(module) || typeof module.type !== 'string'
      || typeof module.uuid !== 'string' || !uuidPattern.test(module.uuid)
      || !isVersion(module.version)) {
      fail(`modules[${index}]`);
    }

    const fields = module;

    if (['data', 'script', 'resources'].includes(module.type)
      && !isVersion(header.min_engine_version)) {
      fail('header.min_engine_version');
    }

    if (fields.type === 'script' && (fields.language !== 'javascript'
      || typeof fields.entry !== 'string' || !/^scripts\/.+\.js$/.test(fields.entry)
      || fields.entry.split('/').some(part => part === '..' || part === '.' || part === '')
      || fields.entry.includes('\\'))) {
      fail(`modules[${index}].entry or language`);
    }
  }

  return value as unknown as Manifest;
}

/** Read declared runtime entries before their bundles exist. */
export async function readScriptEntries(id: string, directory: string): Promise<string[]> {
  const manifest = await readManifest(id, directory);

  return manifest.modules.filter(module => module.type === 'script').map(module => module.entry!);
}

/** Validate identity and script files after all build steps finish. */
export async function validatePackManifests(packs: Record<string, string>): Promise<void> {
  const identities = new Map<string, string>();

  for (const [id, directory] of Object.entries(packs)) {
    const manifest = await readManifest(id, directory);

    for (const uuid of [manifest.header.uuid, ...manifest.modules.map(module => module.uuid)]) {
      const key = uuid.toLowerCase();
      const previous = identities.get(key);

      if (previous) {
        throw new Error(`Pack ${id} has duplicate manifest UUID ${uuid}; already used by ${previous}`);
      }

      identities.set(key, id);
    }

    for (const module of manifest.modules.filter(module => module.type === 'script')) {
      const file = path.resolve(directory, module.entry!);

      try {
        const relative = path.relative(await realpath(directory), await realpath(file));

        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(file)).isFile()) {
          throw new Error('Entry must be a file inside its pack');
        }
      } catch (cause) {
        throw new Error(`Pack ${id} script entry is missing or invalid: ${module.entry}`, { cause });
      }
    }
  }
}
