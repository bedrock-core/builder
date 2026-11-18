import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { auditRelease } from './audit.ts';
import { diffReleases } from './diff.ts';
import { compareVersions, readReleases, releasesFile, reportsRoot, stableTag, type TypeRelease } from './releases.ts';

interface UpstreamRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; digest?: string; browser_download_url: string }[];
}

interface Sdk {
  gitHead?: string;
  dist?: { integrity?: string };
}

async function github<T>(repository: 'bedrock-schemas' | 'bedrock-samples', request: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/Mojang/${repository}/${request}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Mojang ${repository} ${request} returned HTTP ${response.status}`);
  }

  return await response.json() as T;
}

async function sdkVersion(version: string): Promise<Sdk | undefined> {
  const response = await fetch(`https://registry.npmjs.org/@minecraft%2Fbedrock-schemas/${version}`, { signal: AbortSignal.timeout(30000) });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Mojang schema SDK ${version} returned HTTP ${response.status}`);
  }

  return await response.json() as Sdk;
}

const stable = (release: UpstreamRelease): boolean => !release.draft && !release.prerelease && stableTag.test(release.tag_name);
const { values } = parseArgs({ options: { tag: { type: 'string' } } });

if (values.tag && !stableTag.test(values.tag)) {
  throw new Error('Use a stable Mojang schema release tag such as v1.26.60.5.');
}

const pins = await readReleases();
const recent = 'releases?per_page=100';
const [schemas, samples] = await Promise.all([
  values.tag
    ? github<UpstreamRelease>('bedrock-schemas', 'releases/tags/' + values.tag).then(release => [release])
    : github<UpstreamRelease[]>('bedrock-schemas', recent),
  github<UpstreamRelease[]>('bedrock-samples', recent),
]);
const sampleReleases = samples.filter(stable).sort((left, right) => compareVersions(right.tag_name, left.tag_name));
const newest = Object.keys(pins).sort(compareVersions).at(-1)!;
const additions: Record<string, TypeRelease> = {};

for (const schema of schemas.filter(stable)) {
  const tag = schema.tag_name;
  const version = tag.slice(3);
  const track = stableTag.exec(tag)![1];

  if (Object.values(pins).some(pin => pin.schemaTag === tag) || (!values.tag && compareVersions(version, newest) <= 0)) {
    continue;
  }

  const sample = sampleReleases.find(release => release.tag_name === tag)
    ?? sampleReleases.find(release => stableTag.exec(release.tag_name)![1] === track);
  const sampleTag = sample?.tag_name;
  const filename = `bedrock-samples-${sampleTag}-full.zip`;
  const asset = sample?.assets.find(asset => asset.name === filename);
  const sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? '')?.[1];

  if (!sampleTag || !sha256 || asset?.browser_download_url !== `https://github.com/Mojang/bedrock-samples/releases/download/${sampleTag}/${filename}`) {
    console.info(`Waiting for a checksummed stable samples archive for ${tag}`);
    continue;
  }

  const [sdk, commit] = await Promise.all([sdkVersion(track), github<{ sha: string }>('bedrock-schemas', 'commits/' + tag)]);

  if (sdk?.gitHead !== commit.sha || !/^sha512-[a-zA-Z0-9+/]{86}==$/.test(sdk.dist?.integrity ?? '')) {
    console.info(`Waiting for npm SDK ${track} from the commit tagged ${tag}`);
    continue;
  }

  additions[version] = {
    schemaTag: tag,
    schemaVersion: track,
    schemaCommit: commit.sha,
    schemaIntegrity: sdk.dist!.integrity!,
    samplesTag: sampleTag,
    samplesSha256: sha256,
  };
}

const versions = Object.keys(additions).sort(compareVersions);
const output = process.env.GITHUB_OUTPUT;

if (output) {
  await appendFile(output, 'updated=' + Boolean(versions.length) + '\n');
}

if (!versions.length) {
  console.info('No new stable Bedrock schema source pairs were found.');
} else {
  const releases = { ...pins, ...additions };
  const ordered = Object.keys(releases).sort(compareVersions);
  const summary = ['| Types version | Schema SDK | Bedrock samples | New findings | Dist files changed |', '| --- | --- | --- | ---: | ---: |'];

  await writeFile(releasesFile, JSON.stringify(Object.fromEntries(ordered.map(version => [version, releases[version]])), null, 2) + '\n');

  for (const version of versions) {
    const pin = additions[version];
    const sources = `| ${version} | ${pin.schemaVersion} (${pin.schemaTag}) | ${pin.samplesTag} |`;

    try {
      const audit = await auditRelease(version);
      const index = ordered.indexOf(version);
      const diff = index > 0 ? await diffReleases(ordered[index - 1], version) : undefined;

      summary.push(sources + ` ${audit.counts.newIssues} | ${diff ? diff.added.length + diff.changed.length + diff.removed.length : '—'} |`);
    } catch (error) {
      const directory = path.join(reportsRoot, version);

      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'audit-error.txt'), String(error) + '\n');
      console.error(error);
      summary.push(sources + ' Review generation failure | — |');
    }
  }

  console.info(summary.join('\n'));

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  }
}
