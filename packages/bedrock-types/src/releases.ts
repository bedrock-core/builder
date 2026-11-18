import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetadataSource } from './inputs/metadata.ts';

export interface TypeRelease {
  schemaTag: string;
  schemaVersion: string;
  schemaCommit: string;
  schemaIntegrity: string;
  samplesTag: string;
  samplesSha256: string;
}

export const root = fileURLToPath(new URL('../', import.meta.url));
export const releasesFile = path.join(root, 'releases.json');
export const archiveCache = path.join(root, '.bedrock-core/cache/schema-types');
export const reportsRoot = path.join(root, '.bedrock-core/releases');
export const stableTag = /^v(1\.\d+\.\d+)\.(\d+)$/;

export function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

export async function readReleases(): Promise<Record<string, TypeRelease>> {
  const releases = JSON.parse(await readFile(releasesFile, 'utf8')) as Record<string, TypeRelease>;

  for (const [version, release] of Object.entries(releases)) {
    const schema = stableTag.exec(release.schemaTag);
    const samples = stableTag.exec(release.samplesTag);

    if (
      !schema || !samples || schema[1] !== release.schemaVersion || samples[1] !== release.schemaVersion
      || (version !== release.schemaTag.slice(3) && !(version === '26.50.5' && release.schemaTag === 'v1.26.50.26'))
      || !/^[a-f0-9]{40}$/.test(release.schemaCommit)
      || !/^sha512-[a-zA-Z0-9+/]{86}==$/.test(release.schemaIntegrity)
      || !/^[a-f0-9]{64}$/.test(release.samplesSha256)
    ) {
      throw new Error('Invalid or mixed-track Bedrock schema sources for ' + version);
    }
  }

  return releases;
}

export function metadataSource(release: TypeRelease): MetadataSource {
  const tag = release.samplesTag;

  return {
    url: `https://github.com/Mojang/bedrock-samples/releases/download/${tag}/bedrock-samples-${tag}-full.zip`,
    sha256: release.samplesSha256,
    componentVersion: release.schemaVersion,
  };
}
