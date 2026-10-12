import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext, PackDependency, PackInfo, PackSelector } from './index.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Ownership and native resource destination for a project feature. */
export interface FeatureRouting {
  /** Configured owner ID; omission selects the sole script pack, or sole pack. */
  owner?: string;
  /** Direct local resource dependency; required when more than one candidate exists. */
  resourcePack?: string;
}

/** Resolve a feature against the full graph, including in a targeted invocation. */
export async function resolveFeaturePacks(context: BuildContext, settings: FeatureRouting, client = true): Promise<readonly PackInfo[]> {
  const packs = context.inspectPacks ? await context.inspectPacks() : await inspectPacks(context.allPacks ?? context.packs);
  const owner = resolvePackOwner(packs, settings.owner ?? context.pack?.id);
  const resource = client ? resolveResourcePack(packs, owner, settings.resourcePack) : undefined;

  if (!client && settings.resourcePack !== undefined) {
    throw new Error('resourcePack cannot be selected when client output is disabled');
  }

  return resource && resource.id !== owner.id ? [owner, resource] : [owner];
}

function freeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

/** Read one current native manifest; dependency classification requires inspectPacks. */
export async function inspectPack(id: string, directory: string): Promise<PackInfo> {
  const manifest: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));

  return describePack(id, directory, manifest);
}

/** Describe an already resolved manifest without reading or writing its directory. */
export function describePack(id: string, directory: string, manifest: unknown): PackInfo {
  if (!record(manifest) || !Array.isArray(manifest.modules)) {
    throw new Error(`Pack ${id} requires manifest.modules for classification`);
  }

  const moduleTypes = manifest.modules.flatMap(module => record(module) && typeof module.type === 'string' ? [module.type] : []);
  const behavior = moduleTypes.some(type => type === 'data' || type === 'script');
  const resource = moduleTypes.includes('resources');

  if (behavior && resource) {
    throw new Error(`Pack ${id} contains behavior and resource modules; its type is ambiguous`);
  }

  const header = record(manifest.header) ? manifest.header : {};

  return Object.freeze({
    id, path: directory,
    kind: behavior ? 'behavior' : resource ? 'resource' : 'other',
    moduleTypes: Object.freeze(moduleTypes),
    ...(typeof header.uuid === 'string' ? { uuid: header.uuid } : {}),
    ...(typeof header.version === 'string' ? { version: header.version } : {}),
    manifest: freeze(manifest) as Readonly<Record<string, unknown>>,
  });
}

/**
 * Inspect current manifests and resolve requirements without sorting pack execution.
 * @param directories Project pack IDs mapped to native manifest directories.
 * @returns Frozen descriptors in configured order, with local, external and scripting requirements.
 * @throws If header UUIDs collide or a local requirement mismatches its selected target version.
 */
export async function inspectPacks(directories: Readonly<Record<string, string>>): Promise<readonly PackInfo[]> {
  const packs = await Promise.all(Object.entries(directories).map(([id, directory]) => inspectPack(id, directory)));

  return resolvePackGraph(packs);
}

/** Resolve local requirements across supplied descriptors without imposing build order. */
export function resolvePackGraph(packs: readonly PackInfo[]): readonly PackInfo[] {
  const identities = new Map<string, PackInfo>();

  for (const pack of packs) {
    if (pack.uuid) {
      const previous = identities.get(pack.uuid.toLowerCase());

      if (previous) {
        throw new Error(`Pack ${pack.id} has duplicate manifest UUID ${pack.uuid}; already used by ${previous.id}`);
      }

      identities.set(pack.uuid.toLowerCase(), pack);
    }
  }

  return Object.freeze(packs.map((pack) => {
    const declared = pack.manifest?.dependencies;

    if (declared !== undefined && !Array.isArray(declared)) {
      throw new Error(`Pack ${pack.id} manifest.dependencies must be an array`);
    }

    const dependencies: PackDependency[] = (declared ?? []).map((dependency: unknown) => {
      if (!record(dependency) || typeof dependency.version !== 'string'
        || (typeof dependency.uuid === 'string') === (typeof dependency.module_name === 'string')) {
        throw new Error(`Pack ${pack.id} has an invalid manifest dependency`);
      }

      if (typeof dependency.module_name === 'string') {
        return Object.freeze({ kind: 'module', moduleName: dependency.module_name, version: dependency.version });
      }

      const uuid = dependency.uuid as string;
      const target = identities.get(uuid.toLowerCase());

      if (!target) {
        return Object.freeze({ kind: 'external', uuid, version: dependency.version });
      }

      if (dependency.version !== target.version) {
        throw new Error(`Pack ${pack.id} dependency on ${target.id} requires ${dependency.version}, but its selected manifest is ${target.version}`);
      }

      return Object.freeze({ kind: 'local', packId: target.id, uuid, version: dependency.version });
    });

    return Object.freeze({ ...pack, dependencies: Object.freeze(dependencies) });
  }));
}

/** Select each pack once, intersecting explicit IDs with any-of module capabilities. */
export function selectPacks(packs: readonly PackInfo[], selector: PackSelector): readonly PackInfo[] {
  for (const id of selector.packs ?? []) {
    if (!packs.some(pack => pack.id === id)) {
      throw new Error(`Pack selector references an unknown pack: ${id}`);
    }
  }

  return packs.filter(pack => (!selector.packs || selector.packs.includes(pack.id))
    && (!selector.modules || selector.modules.some(type => pack.moduleTypes.includes(type))));
}

/** Resolve an explicit feature owner, otherwise the sole script pack or sole pack. */
export function resolvePackOwner(packs: readonly PackInfo[], id?: string): PackInfo {
  if (id !== undefined) {
    const owner = packs.find(pack => pack.id === id);

    if (!owner) {
      throw new Error(`Feature owner is not a configured pack: ${id}`);
    }

    return owner;
  }

  const scripts = packs.filter(pack => pack.moduleTypes.includes('script'));
  const candidates = scripts.length ? scripts : packs;

  if (candidates.length !== 1) {
    throw new Error(`Feature needs an explicit owner; candidates: ${candidates.map(pack => pack.id).join(', ') || 'none'}`);
  }

  return candidates[0]!;
}

/**
 * Resolve a writable local resource destination from an owner's direct requirements.
 * A resource owner may emit into itself. External requirements are never writable candidates.
 * @throws If the destination is missing, ambiguous, lacks resources or is not required by the owner.
 */
export function resolveResourcePack(packs: readonly PackInfo[], owner: PackInfo, id?: string): PackInfo {
  const ids = new Set((owner.dependencies ?? []).flatMap(dependency => dependency.kind === 'local' ? [dependency.packId] : []));
  const candidates = packs.filter(pack => pack.moduleTypes.includes('resources') && (pack.id === owner.id || ids.has(pack.id)));

  if (id !== undefined) {
    const target = packs.find(pack => pack.id === id);

    if (!target || !target.moduleTypes.includes('resources')) {
      throw new Error(`Resource destination must be a configured pack declaring resources: ${id}`);
    }

    if (target.id !== owner.id && !ids.has(target.id)) {
      throw new Error(`Pack ${owner.id} must declare a dependency on resource destination ${id}`);
    }

    return target;
  }

  if (candidates.length !== 1) {
    throw new Error(`Pack ${owner.id} needs an explicit resource destination; direct local candidates: ${candidates.map(pack => pack.id).join(', ') || 'none'}`);
  }

  return candidates[0]!;
}
