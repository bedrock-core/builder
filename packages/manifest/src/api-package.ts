/** Published API ownership, independent of the JavaScript entry layout. */
export interface ApiPackageMetadata {
  formatVersion: '1.0.0';
  manifests: Record<string, string>;
  nativeAccess?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Public addon packages expose an owner manifest alongside their explicit entries. */
export function hasApiExports(metadata: unknown): boolean {
  if (!record(metadata) || !record(metadata.exports)) {
    return false;
  }

  const manifest = (key: string): boolean => key === './manifest.json' || key.endsWith('/manifest.json');
  const keys = Object.keys(metadata.exports);

  return keys.some(manifest) && keys.some(key => !manifest(key));
}

/** Read the explicit portable-API marker without importing package code. */
export function apiPackageMetadata(metadata: Record<string, unknown>): ApiPackageMetadata | undefined {
  const core = metadata.bedrockCore;

  if (!record(core) || core.api === undefined) {
    return;
  }

  const api = core.api;

  if (!record(api) || api.formatVersion !== '1.0.0' || !record(api.manifests) || !Object.keys(api.manifests).length
    || (api.nativeAccess !== undefined && typeof api.nativeAccess !== 'boolean')) {
    throw new Error(`Addon package ${String(metadata.name)} has invalid or unsupported bedrockCore.api metadata`);
  }

  const manifests: Record<string, string> = {};

  for (const [subpath, manifest] of Object.entries(api.manifests)) {
    if (!(subpath === '.' || (subpath.startsWith('./') && !subpath.includes('*') && !subpath.includes('\\') && !subpath.split('/').includes('..')))
      || typeof manifest !== 'string' || !manifest.startsWith('./') || manifest.includes('\\') || !manifest.endsWith('.json')) {
      throw new Error(`Addon package ${String(metadata.name)} has an invalid API manifest mapping for ${subpath}`);
    }

    manifests[subpath] = manifest;
  }

  return { formatVersion: '1.0.0', manifests, ...api.nativeAccess === true && { nativeAccess: true } };
}
