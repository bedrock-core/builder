import type { JavaArtifact, JavaManifest, MappingSource, Release, Sources, VersionManifest } from './types.ts';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cache } from '../paths.ts';
import { jsonBytes, manifestArtifacts } from './java.ts';

const digest = (bytes: Uint8Array, algorithm = 'sha256'): string => createHash(algorithm).update(bytes).digest('hex');

export async function sourceDownload(url: string, { maxBytes = 2 * 1024 * 1024 } = {}): Promise<Buffer> {
  const location = new URL(url), host = location.hostname;

  if (location.protocol !== 'https:' || !['api.github.com', 'github.com', 'raw.githubusercontent.com', 'piston-meta.mojang.com', 'piston-data.mojang.com', 'libraries.minecraft.net'].includes(host)) {
    throw new Error('Unexpected asset source host');
  }

  const response = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'bedrock-core-asset-maps', ...(host === 'api.github.com' && process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}) }, signal: AbortSignal.timeout(60000) });

  if (!response.ok) {
    throw new Error(`Asset source HTTP ${response.status}: ${url}`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of response.body!) {
    size += chunk.length;

    if (size > maxBytes) {
      throw new Error('Asset source exceeds its size limit');
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export const sourceJson = async <T>(url: string): Promise<T> => JSON.parse((await sourceDownload(url)).toString('utf8'));

/** Published Geyser releases declare the exact Java and Bedrock version pair. */
export function geyserReleasePair(release: Release): MappingSource | undefined {
  const java = release.body?.match(/Java Edition ([\d.]+)/)?.[1], bedrock = release.body?.match(/Bedrock Edition ([\d.]+)/)?.[1]?.replace(/\.$/, '');
  const archive = release.assets?.find(asset => /-full\.zip$/.test(asset.name));

  if (release.draft || !java || !bedrock || !archive?.browser_download_url?.startsWith(`https://github.com/GeyserMC/mappings-generator/releases/download/${release.tag_name}/`) || !/^sha256:[a-f0-9]{64}$/.test(archive.digest)) {
    return undefined;
  }

  return { version: release.tag_name, java, bedrock, archive: { url: archive.browser_download_url, sha256: archive.digest.slice(7) } };
}

export function matchingGeyserRelease(releases: Release[], target: string, java?: string): MappingSource | undefined {
  const compare = (a: MappingSource, b: MappingSource): number => {
    const left = a.version.match(/\d+/g)!.map(Number), right = b.version.match(/\d+/g)!.map(Number);

    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) {
        return (right[i] ?? 0) - (left[i] ?? 0);
      }
    }

    return 0;
  };

  return releases.map(geyserReleasePair).filter((pair): pair is MappingSource => Boolean(pair && pair.bedrock === target && (!java || pair.java === java))).sort(compare)[0];
}

export async function resolveSourcePins({ current, bedrock = current.bedrock.minecraft, channel = current.bedrock.channel, mappings, java }: { current: Sources; bedrock?: string; channel?: string; mappings?: string; java?: string }): Promise<Sources> {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(bedrock) || !['stable', 'preview'].includes(channel)) {
    throw new Error('Select an exact Bedrock release and its channel');
  }

  const tag = 'v' + bedrock + (channel === 'preview' ? '-preview' : '');
  const [native, releases, versions] = await Promise.all([
    sourceJson<Release>('https://api.github.com/repos/Mojang/bedrock-samples/releases/tags/' + encodeURIComponent(tag)),
    mappings ? sourceJson<Release>('https://api.github.com/repos/GeyserMC/mappings-generator/releases/tags/' + encodeURIComponent(mappings)).then(value => [value]) : sourceJson<Release[]>('https://api.github.com/repos/GeyserMC/mappings-generator/releases?per_page=100'),
    sourceJson<VersionManifest>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
  ]);
  const pair = matchingGeyserRelease(releases, bedrock.split('.').slice(0, 3).join('.'), java);

  if (!pair) {
    throw new Error('No published Geyser mapping release matches the requested Java/Bedrock pair');
  }

  const archive = native.assets?.find(asset => /-full\.zip$/.test(asset.name));

  if (native.draft || native.tag_name !== tag || !archive?.browser_download_url?.startsWith(`https://github.com/Mojang/bedrock-samples/releases/download/${tag}/`) || !/^sha256:[a-f0-9]{64}$/.test(archive.digest)) {
    throw new Error('Mojang release has no hash-pinned full resource archive');
  }

  const entry = versions.versions.find(value => value.id === pair.java);

  if (!entry?.url?.startsWith('https://piston-meta.mojang.com/') || !/^[a-f0-9]{40}$/.test(entry.sha1)) {
    throw new Error('No official Java version manifest matches the Geyser release');
  }

  const metadataBytes = await sourceDownload(entry.url);

  if (digest(metadataBytes, 'sha1') !== entry.sha1) {
    throw new Error('Java version manifest hash mismatch');
  }

  const metadata: JavaManifest = JSON.parse(metadataBytes.toString('utf8'));

  if (metadata.id !== pair.java || !metadata.downloads?.client) {
    throw new Error('Official Java manifest has the wrong version');
  }

  const prior = new Map([current.java.client, ...current.java.libraries].map(artifact => [artifact.sha1, artifact]));
  const artifacts = manifestArtifacts(metadata);
  const resolved: JavaArtifact[] = [];
  let cursor = 0;

  await mkdir(cache, { recursive: true });
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < artifacts.length) {
      const artifact = artifacts[cursor++], previous = prior.get(artifact.sha1);

      if (!/^[a-f0-9]{40}$/.test(artifact.sha1) || artifact.size <= 0) {
        throw new Error('Java manifest contains an invalid artifact');
      }

      if (previous?.url === artifact.url && previous.size === artifact.size) {
        resolved.push({ ...artifact, sha256: previous.sha256 });
        continue;
      }

      const content = await sourceDownload(artifact.url, { maxBytes: 128 * 1024 * 1024 });

      if (content.length !== artifact.size || digest(content, 'sha1') !== artifact.sha1) {
        throw new Error('Java artifact does not match its Mojang manifest');
      }

      const sha256 = digest(content), file = join(cache, sha256 + '.jar');
      const temporary = file + '.' + process.pid + '.tmp';

      await writeFile(temporary, content);
      await rename(temporary, file);
      resolved.push({ ...artifact, sha256 });
    }
  }));
  resolved.sort((a, b) => a.name.localeCompare(b.name));
  const licenseUrl = `https://raw.githubusercontent.com/Mojang/bedrock-samples/${tag}/LICENSE.md`;
  const license = await sourceDownload(licenseUrl), licenseHash = digest(license), manifestHash = digest(metadataBytes);

  await writeFile(join(cache, licenseHash), license);
  await writeFile(join(cache, manifestHash), metadataBytes);
  const result = { schemaVersion: 1, bedrock: { minecraft: bedrock, channel, repository: 'https://github.com/Mojang/bedrock-samples', tag,
    archive: { url: archive.browser_download_url, sha256: archive.digest.slice(7) }, license: { file: 'MOJANG-LICENSE.txt', url: licenseUrl, sha256: licenseHash } },
  java: { version: pair.java, majorVersion: metadata.javaVersion.majorVersion, manifest: { url: entry.url, sha1: entry.sha1, sha256: manifestHash },
    client: resolved.find(value => value.name === 'client')!, libraries: resolved.filter(value => value.name !== 'client') }, mappings: pair, policy: current.policy };

  return jsonBytes(result).equals(jsonBytes(current)) ? current : result;
}
