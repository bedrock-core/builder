import { readFile, realpath, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { JsonFormatting, ProjectMetadata } from '@bedrock-core/builder-plugin';
import { validateAddonFields } from './authoring.ts';
import { resolveModuleDependency } from './modules.ts';

export { moduleManifestPath } from './modules.ts';
export { apiPackageMetadata, hasApiExports, type ApiPackageMetadata } from './api-package.ts';
export { nativeManifest, finalizePackManifests, scriptOutputEntry, scriptOutputManifest } from './authoring.ts';
export { prepareAddonArtwork } from './artwork.ts';

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
 * @param authored Allow authored TypeScript entries before bundling.
 * @returns Validated v3 manifest metadata; compiled script files are not required yet.
 */
export async function readManifest(id: string, directory: string, authored = false): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));

  return validateManifest(id, value, authored);
}

/** Validate v3 fields. Authored documents may refer to TypeScript sources before bundling. */
export function validateManifest(id: string, value: unknown, authored = false): Manifest {
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

    if (fields.type === 'script') {
      if (fields.language !== 'javascript') {
        fail(`modules[${index}].language; use "javascript" for the exported script module`);
      }

      const entry = fields.entry;
      const label = `modules[${index}].entry (${JSON.stringify(entry) ?? 'missing'})`;

      if (typeof entry !== 'string' || !entry.startsWith('scripts/')
        || entry.split('/').some(part => part === '..' || part === '.' || part === '')
        || /[\\:*?"<>|\u0000-\u001f]/.test(entry)) { // eslint-disable-line no-control-regex -- Script paths must reject ASCII control characters.
        fail(`${label}; use a pack-relative path under scripts/, such as scripts/main.${authored ? 'ts' : 'js'}`);
      }

      const extension = authored ? /[^/]\.(?:js|ts|tsx|mts|cts)$/ : /[^/]\.js$/;

      if (!extension.test(entry) || /\.d\.(?:ts|mts|cts)$/.test(entry)) {
        fail(`${label}; ${authored ? 'use .js, .ts, .tsx, .mts or .cts (for example scripts/main.ts)' : 'exported scripts must use .js (for example scripts/main.js); run the bundler for TypeScript sources'}`);
      }
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
  const requestedRoot = options.root === undefined ? undefined : path.resolve(options.root);
  const root = requestedRoot === undefined ? undefined : await realpath(requestedRoot);
  const inputs = new Set<string>();

  async function resolve(source: string, ancestors: readonly string[]): Promise<JsonObject> {
    options.signal?.throwIfAborted();
    const absolute = path.resolve(source);

    if (root !== undefined && requestedRoot !== undefined) {
      const within = [root, requestedRoot].some((base) => {
        const relative = path.relative(base, absolute);

        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });

      if (!within) {
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
    validateManifest(file, manifest, true);
  }

  return { manifest, inputs: [...inputs] };
}

/**
 * Complete cloned manifests with shared metadata and local pack references.
 * Explicit header/module fields win. UUIDs must be authored and are never generated here.
 * Local namespace references select behavior packs or their paired resources.
 * All documents are validated before returning; reciprocal requirements are permitted.
 */
export function resolveProjectManifests(inputs: Readonly<Record<string, JsonObject>>, project: ProjectMetadata, options: { dependencyRoot?: string; registerDependency?: (file: string) => void } = {}): Record<string, JsonObject> {
  const manifests = structuredClone(inputs);
  const namespaces = new Map<string, string>();
  const resources = new Map<string, string[]>();
  const scripted = new Set<string>();

  for (const [id, manifest] of Object.entries(manifests)) {
    if (!isRecord(manifest.header) || !Array.isArray(manifest.modules)) {
      throw new Error(`Pack ${id} needs an authored header and modules`);
    }

    if (manifest.modules.some(module => isRecord(module) && module.type === 'script')) {
      scripted.add(id);
    }

    if (typeof manifest.namespace === 'string' && manifest.modules.some(module => isRecord(module) && (module.type === 'script' || module.type === 'data'))) {
      const previous = namespaces.get(manifest.namespace);

      if (previous) {
        throw new Error(`Duplicate addon namespace ${manifest.namespace}: ${previous} and ${id}`);
      }

      namespaces.set(manifest.namespace, id);
    }

    if (typeof manifest.namespace === 'string' && manifest.modules.some(module => isRecord(module) && module.type === 'resources')) {
      resources.set(manifest.namespace, [...(resources.get(manifest.namespace) ?? []), id]);
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
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      if (!Array.isArray(manifest[field])) {
        continue;
      }

      manifest[field] = manifest[field].map((value) => {
        if (!isRecord(value)) {
          return value;
        }

        const dependency = value as JsonObject;

        if (dependency.pack !== undefined) {
          throw new Error(`Pack ${id} has invalid dependency.pack; identify local packs by namespace`);
        }

        if (dependency.module !== undefined) {
          throw new Error(`Pack ${id} has invalid dependency.module; use module_name`);
        }

        if (dependency.module_name !== undefined) {
          if (typeof dependency.module_name !== 'string' || !dependency.module_name.trim()
            || dependency.uuid !== undefined) {
            throw new Error(`Pack ${id} has invalid ${field} module_name dependency`);
          }

          const selected = resolveModuleDependency(dependency, options, mergeObjects);

          delete dependency.module_name;
          Object.assign(dependency, selected);
        }

        const uuidId = typeof dependency.uuid === 'string' ? uuids.get(dependency.uuid.toLowerCase()) : undefined;
        const behaviorId = typeof dependency.namespace === 'string' ? namespaces.get(dependency.namespace) : undefined;
        const resourceIds = typeof dependency.namespace === 'string' ? (resources.get(dependency.namespace) ?? []).filter(candidate => candidate !== id) : [];
        const namespaceId = behaviorId !== id && behaviorId !== undefined ? behaviorId : resourceIds.length === 1 ? resourceIds[0] : undefined;
        // An explicit UUID distinguishes external owners from local packs sharing their namespace.
        const targetId = uuidId ?? (dependency.uuid === undefined ? namespaceId : undefined);

        if (dependency.uuid === undefined && dependency.module_name === undefined && dependency.namespace !== undefined && !namespaceId) {
          if (resourceIds.length > 1) {
            throw new Error(`Pack ${id} dependency namespace ${String(dependency.namespace)} has multiple resource packs; select one by UUID`);
          }

          if (dependency.namespace === manifest.namespace) {
            throw new Error(`Pack ${id} cannot depend on its own addon namespace without a paired pack`);
          }

          throw new Error(`Pack ${id} dependency namespace ${String(dependency.namespace)} does not identify a local pack; external addons need a native UUID/version`);
        }

        if (targetId) {
          const target = manifests[targetId].header as JsonObject;
          const targetNamespace = manifests[targetId].namespace;

          if (dependency.namespace !== undefined && dependency.namespace !== targetNamespace) {
            throw new Error(`Pack ${id} dependency on ${targetId} must use addon namespace ${String(targetNamespace)}`);
          }

          if (dependency.uuid !== undefined && (typeof dependency.uuid !== 'string' || dependency.uuid.toLowerCase() !== String(target.uuid).toLowerCase())) {
            throw new Error(`Pack ${id} dependency namespace ${String(dependency.namespace)} must use native UUID ${String(target.uuid)}`);
          }

          if (dependency.module_name !== undefined) {
            throw new Error(`Pack ${id} has invalid ${field}; native modules cannot identify addon namespaces`);
          }

          dependency.uuid = target.uuid;
          dependency.version ??= target.version;

          if (dependency.version !== target.version) {
            throw new Error(`Pack ${id} dependency on ${targetId} must use selected version ${String(target.version)}`);
          }

          if (!scripted.has(targetId)) {
            delete dependency.namespace;
          }
        }

        if (!scripted.has(id)) {
          delete dependency.namespace;
        }

        return dependency;
      });
    }

    validateAddonFields(id, manifest);
    validateManifest(id, manifest, true);
  }

  return manifests;
}

/**
 * Read authored script entries before their bundles exist.
 * @param id Configured pack ID used in diagnostics.
 * @param directory Directory containing the current pack manifest.
 * @returns Relative entry paths declared by the current manifest script modules.
 */
export async function readScriptEntries(id: string, directory: string): Promise<string[]> {
  const manifest = await readManifest(id, directory, true);

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
