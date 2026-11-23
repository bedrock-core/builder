import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reports, root } from './paths.ts';
import type { Sources } from './sources/types.ts';

export interface AssetRelease {
  samplesTag: string;
  samplesSha256: string;
  inputs?: 'data';
}

export type AssetChannel = Sources['bedrock']['channel'];
export type AssetInputFiles = Record<'sources.json' | 'native-states.json' | 'native-bindings.json' | 'renderer-profiles.json' | 'texture-rules.json', Buffer>;

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview)?$/;
const releasesFile = path.join(root, 'releases.json');

export const releaseReports = path.join(reports, 'releases');

export function assetVersion(samplesTag: string): string {
  const version = samplesTag.slice(3);

  if (!samplesTag.startsWith('v1.') || !versionPattern.test(version)) {
    throw new Error('Unsupported Bedrock Samples release tag: ' + samplesTag);
  }

  return version;
}

export function releaseChannel(version: string): AssetChannel {
  return version.endsWith('-preview') ? 'preview' : 'stable';
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('-')[0].split('.').map(Number);
  const right = b.split('-')[0].split('.').map(Number);

  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || Number(releaseChannel(b) === 'preview') - Number(releaseChannel(a) === 'preview');
}

export async function workspaceVersion(): Promise<string> {
  const manifest: { version: string } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  return manifest.version;
}

function checkedVersion(version: string): string {
  if (!versionPattern.test(version)) {
    throw new Error('Invalid Asset Maps version: ' + version);
  }

  return version;
}

export const candidateInputs = (version: string, packageRoot = root): string => path.join(packageRoot, 'data', 'releases', checkedVersion(version));
export const releaseOutput = (version: string): string => path.join(releaseReports, checkedVersion(version), 'dist');

export async function readReleases(file = releasesFile): Promise<Record<string, AssetRelease>> {
  const releases: Record<string, AssetRelease> = JSON.parse(await readFile(file, 'utf8'));
  let shared = false;

  for (const [version, release] of Object.entries(releases)) {
    if (assetVersion(release.samplesTag) !== version || !/^[a-f0-9]{64}$/.test(release.samplesSha256)
      || (release.inputs !== undefined && (release.inputs !== 'data' || shared))) {
      throw new Error('Invalid Asset Maps source record: ' + version);
    }

    shared ||= release.inputs === 'data';
  }

  return releases;
}

export async function readAssetRelease(version?: string, file = releasesFile) {
  version ??= await workspaceVersion();
  const releases = await readReleases(file);
  const entry = Object.hasOwn(releases, version) ? releases[version] : undefined;

  if (!entry) {
    throw new Error('Unknown Asset Maps release: ' + version);
  }

  const packageRoot = path.dirname(file);
  const directory = entry.inputs === 'data' ? path.join(packageRoot, 'data') : candidateInputs(version, packageRoot);
  const sourceBytes = await readFile(path.join(directory, 'sources.json'));
  const source: Sources = JSON.parse(sourceBytes.toString('utf8'));

  if (source.bedrock.tag !== entry.samplesTag || source.bedrock.archive.sha256 !== entry.samplesSha256) {
    throw new Error('Asset Maps source pin differs from the release record: ' + version);
  }

  return { version, entry, directory, source, sourceBytes };
}

/** Prospective releases can reuse authored inputs from their review baseline. */
export async function readAssetInput(directory: string, file: keyof AssetInputFiles, fallback?: string): Promise<Buffer> {
  try {
    return await readFile(path.join(directory, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !fallback) {
      throw error;
    }

    return readFile(path.join(fallback, file));
  }
}

/** Make a reviewed version selectable after all of its source files are present. */
export async function registerAssetRelease(source: Sources, files: AssetInputFiles, file = releasesFile): Promise<boolean> {
  const version = assetVersion(source.bedrock.tag);
  const packageRoot = path.dirname(file);
  const directory = candidateInputs(version, packageRoot);
  const registryReports = path.join(packageRoot, '.bedrock-core');
  const lock = path.join(registryReports, 'release-registry.lock');

  await mkdir(registryReports, { recursive: true });
  const owner = await open(lock, 'wx');

  try {
    const releases = await readReleases(file);

    if (Object.hasOwn(releases, version)) {
      const existing = await readAssetRelease(version, file);

      if (!existing.sourceBytes.equals(files['sources.json'])) {
        throw new Error('Source pins already exist for Asset Maps ' + version);
      }

      return false;
    }

    await mkdir(directory, { recursive: true });
    await Promise.all(Object.entries(files).map(([file, bytes]) => writeFile(path.join(directory, file), bytes)));
    releases[version] = { samplesTag: source.bedrock.tag, samplesSha256: source.bedrock.archive.sha256 };
    const ordered = Object.fromEntries(Object.entries(releases).sort(([a], [b]) => compareVersions(a, b)));
    const temporary = path.join(registryReports, 'releases.' + process.pid + '.json');

    try {
      await writeFile(temporary, JSON.stringify(ordered, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    return true;
  } finally {
    await owner.close();
    await unlink(lock);
  }
}
