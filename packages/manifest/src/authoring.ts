import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isManifestVersion, type JsonObject } from './index.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Return the native JavaScript path for an authored script entry. */
export function scriptOutputEntry(entry: string): string {
  return entry.replace(/\.(?:ts|tsx|mts|cts)$/, '.js');
}

/** Produce runtime script paths while retaining addon metadata. */
export function scriptOutputManifest(manifest: JsonObject): JsonObject {
  if (!Array.isArray(manifest.modules)) {
    return manifest;
  }

  let changed = false;
  const modules = manifest.modules.map((module) => {
    if (!record(module) || module.type !== 'script' || typeof module.entry !== 'string') {
      return module;
    }

    const entry = scriptOutputEntry(module.entry);

    if (entry === module.entry) {
      return module;
    }

    changed = true;

    return { ...module, entry } as JsonObject;
  });

  return changed ? { ...manifest, modules } : manifest;
}

/** Check the addon fields that supplement a native authored pack manifest. */
export function validateAddonFields(id: string, manifest: JsonObject): void {
  const validNamespace = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9_]+$/.test(value) && value !== 'minecraft';

  if (manifest.namespace !== undefined && !validNamespace(manifest.namespace)) {
    throw new Error(`Pack ${id} namespace must use lowercase a-z, 0-9 and underscores; minecraft is reserved`);
  }

  if (manifest.thumbnail !== undefined && (typeof manifest.thumbnail !== 'string' || !manifest.thumbnail.trim())) {
    throw new Error(`Pack ${id} thumbnail must name a PNG file`);
  }

  const dependencyIds = (field: 'dependencies' | 'optionalDependencies'): string[] => {
    const values = manifest[field];

    if (values === undefined) {
      return [];
    }

    if (!Array.isArray(values)) {
      throw new Error(`Pack ${id} ${field} must list native dependency objects`);
    }

    return values.flatMap((value, index) => {
      if (!record(value) || !isManifestVersion(value.version)
        || (typeof value.uuid === 'string') === (typeof value.module_name === 'string')
        || (value.uuid !== undefined && (typeof value.uuid !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.uuid)))
        || (value.module_name !== undefined && (typeof value.module_name !== 'string' || !value.module_name.trim()))
        || value.pack !== undefined || value.module !== undefined) {
        throw new Error(`Pack ${id} ${field}[${index}] is invalid; must be a native UUID/version or module_name/version dependency object`);
      }

      if (value.namespace === undefined) {
        return [];
      }

      if (!validNamespace(value.namespace) || typeof value.uuid !== 'string' || value.module_name !== undefined) {
        throw new Error(`Pack ${id} ${field}[${index}] addon namespace needs a native pack UUID/version`);
      }

      return [value.namespace];
    });
  };

  const required = dependencyIds('dependencies');
  const optional = dependencyIds('optionalDependencies');

  if (manifest.namespace === undefined && (required.length || manifest.optionalDependencies !== undefined || manifest.thumbnail !== undefined)) {
    throw new Error(`Pack ${id} addon metadata needs an explicit manifest namespace`);
  }

  if (required.includes(String(manifest.namespace)) || optional.includes(String(manifest.namespace))) {
    throw new Error(`Pack ${id} cannot depend on its own addon namespace`);
  }

  if (required.some(namespace => optional.includes(namespace))) {
    throw new Error(`Pack ${id} has an addon dependency that is both required and optional`);
  }
}

/** Remove authoring metadata while retaining the native UUID/version requirements. */
export function nativeManifest(input: JsonObject): JsonObject {
  const manifest = structuredClone(input);

  for (const field of ['$schema', 'namespace', 'optionalDependencies', 'thumbnail', 'icon']) {
    delete manifest[field];
  }

  if (Array.isArray(manifest.dependencies)) {
    manifest.dependencies = manifest.dependencies.map((value) => {
      if (!record(value)) {
        return value;
      }

      const dependency = { ...value } as JsonObject;

      delete dependency.namespace;

      return dependency;
    });
  }

  return manifest;
}

/** Finalize native documents after source compilation and before final-file receipts. */
export async function finalizePackManifests(packs: Readonly<Record<string, string>>): Promise<void> {
  for (const [id, directory] of Object.entries(packs)) {
    const file = path.join(directory, 'manifest.json');
    const text = await readFile(file, 'utf8');
    const manifest = JSON.parse(text) as JsonObject;

    validateAddonFields(id, manifest);
    const native = nativeManifest(manifest);

    if (JSON.stringify(native) !== JSON.stringify(manifest)) {
      const indent = text.match(/\n([ \t]+)"/)?.[1];

      await writeFile(file, JSON.stringify(native, null, indent) + (text.endsWith('\n') ? '\n' : ''));
    }
  }
}
