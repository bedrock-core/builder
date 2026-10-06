import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PackInfo {
  readonly id: string;
  readonly path: string;
  readonly kind: 'behavior' | 'resource' | 'other';
  readonly moduleTypes: readonly string[];
  readonly defaultDeploymentFolder?: 'development_behavior_packs' | 'development_resource_packs';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Classify the current manifest without assigning meaning to pack names. */
export async function inspectPack(id: string, directory: string): Promise<PackInfo> {
  const manifest: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));

  if (!isRecord(manifest) || !Array.isArray(manifest.modules)) {
    throw new Error(`Pack ${id} requires manifest.modules for classification`);
  }

  const moduleTypes = manifest.modules.flatMap((module: unknown) => {
    return isRecord(module) && typeof module.type === 'string' ? [module.type] : [];
  });
  const behavior = moduleTypes.some(type => type === 'data' || type === 'script');
  const resource = moduleTypes.includes('resources');

  if (behavior && resource) {
    throw new Error(`Pack ${id} contains behavior and resource modules; deployment is ambiguous`);
  }

  const kind = behavior ? 'behavior' : resource ? 'resource' : 'other';
  const defaultDeploymentFolder = behavior
    ? 'development_behavior_packs'
    : resource ? 'development_resource_packs' : undefined;

  return Object.freeze({ id, path: directory, kind, moduleTypes, defaultDeploymentFolder });
}
