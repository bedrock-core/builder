import { readFile, realpath, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { JsonFormatting, ProjectMetadata } from '@bedrock-core/builder-plugin';

const toolVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Manifest files selected by a profile and formatting for the resolved output. */
export interface ManifestSettings {
  /** Project-relative manifest or list of manifests; unselected packs use manifest.json. */
  manifestPath?: string | string[];
  /** Generated JSON formatting; omission or false emits compact JSON. */
  pretty?: JsonFormatting | false;
}

/** Optional project boundary and cancellation for resolving manifest inheritance. */
export interface ManifestResolveOptions {
  /** Defer native validation when project defaults will complete the result; defaults to true. */
  validate?: boolean;
  /** Restrict the selected file and every ancestor to this directory. */
  root?: string;
  /** Cooperative cancellation while reading the inheritance chain. */
  signal?: AbortSignal;
}

/** Complete manifest without extends, and all files read to assemble it. */
export interface ResolvedManifest {
  /** Merged document; validated unless resolve options explicitly defer native validation. */
  manifest: JsonObject;
  /** Absolute source and ancestor paths for dependency tracking. */
  inputs: string[];
}

interface ManifestModule {
  type: string;
  uuid: string;
  version: string;
  language?: string;
  entry?: string;
}

/** Recursively JSON-serializable data. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
/** String-keyed JSON object used for manifest overrides. */
export interface JsonObject { [key: string]: JsonValue }

/** Explicit patches for the standalone manifest transformation helper. */
export interface ManifestOverrides {
  /** Recursively merge header fields. */
  header?: JsonObject;
  /** Recursively merge metadata fields. */
  metadata?: JsonObject;
  /** Replace the dependency list. */
  dependencies?: JsonValue[];
  /** Module patches keyed by existing module UUID; unknown UUIDs fail. */
  modules?: Record<string, JsonObject>;
  /** Replace the entry of the sole script module; multiple script modules require UUID patches. */
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

/**
 * Apply explicit patches while retaining unrelated manifest fields and module identities.
 * @param input Source data accepted by this operation.
 * @param overrides Header, metadata, dependency and existing module-UUID patches.
 * @returns A cloned manifest with recursive object patches and replaced arrays.
 * @remarks Module patches must reference existing UUIDs. scriptEntry requires exactly one script module.
 */
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

/** Check native v3 semantic-version syntax without coercing npm metadata. */
export function isManifestVersion(value: unknown): value is string {
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

/**
 * Read and validate manifest v3 fields without requiring compiled script files.
 * @param id Configured pack ID used in diagnostics.
 * @param directory Directory containing the current pack manifest.
 * @returns Validated v3 manifest metadata; compiled script files are not required yet.
 */
export async function readManifest(id: string, directory: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));

  return validateManifest(id, value);
}

/** Validate a complete native v3 document; script output files are checked separately. */
export function validateManifest(id: string, value: unknown): Manifest {
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

  if (!isManifestVersion(fields.version)) {
    fail('header.version');
  }

  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    fail('modules');
  }

  for (const [index, module] of manifest.modules.entries()) {
    if (!isRecord(module) || typeof module.type !== 'string'
      || typeof module.uuid !== 'string' || !uuidPattern.test(module.uuid)
      || !isManifestVersion(module.version)) {
      fail(`modules[${index}]`);
    }

    const fields = module;

    if (['data', 'script', 'resources'].includes(module.type)
      && !isManifestVersion(header.min_engine_version)) {
      fail('header.min_engine_version');
    }

    if (fields.type === 'script' && (fields.language !== 'javascript'
      || typeof fields.entry !== 'string' || !/^scripts\/.+\.js$/.test(fields.entry)
      || fields.entry.split('/').some(part => part === '..' || part === '.' || part === '')
      || fields.entry.includes('\\'))) {
      fail(`modules[${index}].entry or language`);
    }
  }

  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      fail('dependencies');
    }

    for (const [index, dependency] of manifest.dependencies.entries()) {
      if (!isRecord(dependency) || !isManifestVersion(dependency.version)
        || (typeof dependency.uuid === 'string') === (typeof dependency.module_name === 'string')
        || (dependency.uuid !== undefined && (typeof dependency.uuid !== 'string' || !uuidPattern.test(dependency.uuid)))
        || (dependency.module_name !== undefined && (typeof dependency.module_name !== 'string' || !dependency.module_name.trim()))
        || dependency.pack !== undefined) {
        fail(`dependencies[${index}]`);
      }
    }
  }

  return value as unknown as Manifest;
}

/**
 * Resolve a manifest's relative extends chain and validate the complete v3 document.
 * @param file Selected manifest path, relative to the process working directory or absolute.
 * @param options Optional project boundary and cooperative cancellation.
 * @returns Resolved manifest and all source files; this operation does not write pack files.
 * @remarks Objects merge recursively. Child arrays and scalars replace parent values.
 * @throws If a source is missing, inheritance cycles, a path escapes root or the result is invalid.
 */
export async function resolveManifest(file: string, options: ManifestResolveOptions = {}): Promise<ResolvedManifest> {
  options.signal?.throwIfAborted();
  const root = options.root === undefined ? undefined : await realpath(options.root);
  const inputs = new Set<string>();

  async function resolve(source: string, ancestors: readonly string[]): Promise<JsonObject> {
    options.signal?.throwIfAborted();
    const absolute = path.resolve(source);

    if (root !== undefined) {
      const relative = path.relative(root, absolute);

      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Manifest path must stay inside the project: ${absolute}`);
      }
    }

    const actual = await realpath(absolute);

    if (root !== undefined) {
      const relative = path.relative(root, actual);

      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Manifest path must stay inside the project: ${absolute}`);
      }
    }

    if (ancestors.includes(actual)) {
      throw new Error(`Circular extends chain: ${[...ancestors, actual].join(' -> ')}`);
    }

    const input: unknown = JSON.parse(await readFile(actual, { encoding: 'utf8', signal: options.signal }));

    if (!isRecord(input)) {
      throw new Error(`Manifest must be an object: ${absolute}`);
    }

    inputs.add(actual);
    const parent = input.extends;
    const document = input as JsonObject;

    delete document.extends;

    if (parent === undefined) {
      return document;
    }

    if (typeof parent !== 'string' || !/^\.\.?[\\/]/.test(parent)) {
      throw new Error(`Invalid extends in ${absolute}; use a relative path such as ./manifest.json`);
    }

    return mergeObjects(await resolve(path.resolve(path.dirname(actual), parent), [...ancestors, actual]), document);
  }

  const manifest = await resolve(file, []);

  if (options.validate !== false) {
    validateManifest(file, manifest);
  }

  return { manifest, inputs: [...inputs] };
}

/**
 * Complete cloned manifests with shared metadata and local pack references.
 * Explicit header/module fields win. UUIDs must be authored and are never generated here.
 * Local `{ pack: id }` requirements become native header UUID/version requirements.
 * All documents are validated before returning; reciprocal requirements are permitted.
 */
export function resolveProjectManifests(inputs: Readonly<Record<string, JsonObject>>, project: ProjectMetadata): Record<string, JsonObject> {
  const manifests = structuredClone(inputs);

  for (const [id, manifest] of Object.entries(manifests)) {
    if (!isRecord(manifest.header) || !Array.isArray(manifest.modules)) {
      throw new Error(`Pack ${id} needs an authored header and modules`);
    }

    const header = manifest.header as JsonObject;

    header.name ??= 'pack.name';
    header.description ??= 'pack.description';
    header.version ??= project.version ?? null;
    header.min_engine_version ??= project.targetVersion;

    for (const module of manifest.modules) {
      if (isRecord(module)) {
        module.version ??= header.version;
      }
    }

    if (manifest.metadata !== undefined && !isRecord(manifest.metadata)) {
      throw new Error(`Pack ${id} metadata must be an object`);
    }

    const metadata = (manifest.metadata ?? {}) as JsonObject;

    if (project.authors.length) {
      metadata.authors ??= [...project.authors];
    }

    if (project.license) {
      metadata.license ??= project.license;
    }

    if (project.url) {
      metadata.url ??= project.url;
    }

    if (metadata.generated_with !== undefined && !isRecord(metadata.generated_with)) {
      throw new Error(`Pack ${id} metadata.generated_with must be an object`);
    }

    const generated = (metadata.generated_with ?? {}) as JsonObject;
    const versions = generated['bedrock-core'] ?? [];

    if (!Array.isArray(versions) || versions.some(version => typeof version !== 'string' || !isManifestVersion(version))) {
      throw new Error(`Pack ${id} metadata.generated_with.bedrock-core must list semantic versions`);
    }

    generated['bedrock-core'] = [...new Set([...versions, toolVersion])];
    metadata.generated_with = generated;
    manifest.metadata = metadata;
  }

  const uuids = new Map<string, string>();

  for (const [id, manifest] of Object.entries(manifests)) {
    const uuid = (manifest.header as JsonObject).uuid;

    if (typeof uuid === 'string') {
      if (uuids.has(uuid.toLowerCase())) {
        throw new Error(`Duplicate pack header UUID: ${id} and ${uuids.get(uuid.toLowerCase())}`);
      }

      uuids.set(uuid.toLowerCase(), id);
    }
  }

  for (const [id, manifest] of Object.entries(manifests)) {
    if (Array.isArray(manifest.dependencies)) {
      manifest.dependencies = manifest.dependencies.map((value) => {
        if (!isRecord(value)) {
          return value;
        }

        const dependency = value as JsonObject;
        const targetId = typeof dependency.pack === 'string' ? dependency.pack : typeof dependency.uuid === 'string' ? uuids.get(dependency.uuid.toLowerCase()) : undefined;

        if (dependency.pack !== undefined && (typeof dependency.pack !== 'string' || !Object.hasOwn(manifests, dependency.pack)
          || dependency.uuid !== undefined || dependency.module_name !== undefined)) {
          throw new Error(`Pack ${id} has invalid local pack dependency: ${String(dependency.pack)}`);
        }

        if (targetId) {
          const target = manifests[targetId].header as JsonObject;

          delete dependency.pack;
          dependency.uuid = target.uuid;
          dependency.version ??= target.version;

          if (dependency.version !== target.version) {
            throw new Error(`Pack ${id} dependency on ${targetId} must use selected version ${String(target.version)}`);
          }
        }

        return dependency;
      });
    }

    validateManifest(id, manifest);
  }

  return manifests;
}

/**
 * Read declared runtime entries before their bundles exist.
 * @param id Configured pack ID used in diagnostics.
 * @param directory Directory containing the current pack manifest.
 * @returns Relative entry paths declared by the current manifest script modules.
 */
export async function readScriptEntries(id: string, directory: string): Promise<string[]> {
  const manifest = await readManifest(id, directory);

  return manifest.modules.filter(module => module.type === 'script').map(module => module.entry!);
}

/**
 * Validate identity and script files after all build steps finish.
 * @param packs Configured pack IDs mapped to their directories.
 * @returns Resolves after all identities, entries and script files pass final manifest checks.
 */
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
