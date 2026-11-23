import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { auditRelease } from './audit.ts';
import { diffReleases } from './diff.ts';
import { compareVersions, readReleases, releasesFile, reportsRoot, releaseTag, type TypeRelease } from './releases.ts';

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

const published = (release: UpstreamRelease): boolean => !release.draft && releaseTag.test(release.tag_name)
  && release.prerelease === release.tag_name.endsWith('-preview');
const { values } = parseArgs({
  options: { tag: { type: 'string' }, game: { type: 'string', multiple: true } },
});

if ((values.tag && !releaseTag.test(values.tag)) || values.game?.some(game => !releaseTag.test('v' + game))) {
  throw new Error('Use a Mojang release tag or a four-part game version with the Preview suffix where applicable.');
}

const games = values.game?.map((game) => {
  const [, line, , preview] = releaseTag.exec('v' + game)!;
  const [edition, year, drop] = line.split('.').map(Number);

  return { tag: 'v' + game, line: [edition, year, Math.floor(drop / 10) * 10].join('.'), preview: Boolean(preview) };
});

const matches = (release: UpstreamRelease): boolean => {
  const [, line, , preview] = releaseTag.exec(release.tag_name)!;

  return games ? games.some(game => preview ? game.tag === release.tag_name : !game.preview && game.line === line) : Boolean(values.tag || !preview);
};

const pins = await readReleases();
const recent = 'releases?per_page=100';
const [schemas, samples] = await Promise.all([
  values.tag
    ? github<UpstreamRelease>('bedrock-schemas', 'releases/tags/' + values.tag).then(release => [release])
    : github<UpstreamRelease[]>('bedrock-schemas', recent),
  github<UpstreamRelease[]>('bedrock-samples', recent),
]);
const sampleReleases = samples.filter(published).sort((left, right) => compareVersions(right.tag_name, left.tag_name));
const additions: Record<string, TypeRelease> = {};
const eligible = schemas.filter(published).filter(matches);
const reviewedSdks = new Set(Object.values(pins).map(pin => pin.schemaVersion));
const newestStable = Object.keys(pins).filter(version => !version.endsWith('-preview')).sort(compareVersions).at(-1);

async function waiting(message: string): Promise<void> {
  console.info(message);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '- ' + message + '\n');
  }
}

for (const game of games ?? []) {
  if (!eligible.some(release => game.preview
    ? release.tag_name === game.tag
    : !release.prerelease && releaseTag.exec(release.tag_name)![1] === game.line)) {
    await waiting('Waiting for Mojang schemas for ' + (game.preview ? game.tag : game.line) + '.');
  }
}

for (const schema of eligible) {
  const tag = schema.tag_name;
  const version = tag.slice(3);
  const [, track, build, preview] = releaseTag.exec(tag)!;
  const sdkRelease = preview ? track + '-beta.' + build : track;

  if (reviewedSdks.has(sdkRelease)
    || (!games && !values.tag && !preview && newestStable && compareVersions(version, newestStable) <= 0)) {
    continue;
  }

  const sample = sampleReleases.find(release => release.tag_name === tag)
    ?? (!preview ? sampleReleases.find(release => !release.prerelease && releaseTag.exec(release.tag_name)![1] === track) : undefined);
  const sampleTag = sample?.tag_name;
  const filename = `bedrock-samples-${sampleTag}-full.zip`;
  const asset = sample?.assets.find(asset => asset.name === filename);
  const sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? '')?.[1];

  if (!sampleTag || !sha256 || asset?.browser_download_url !== `https://github.com/Mojang/bedrock-samples/releases/download/${sampleTag}/${filename}`) {
    await waiting(`Waiting for a checksummed Samples archive for ${tag}.`);
    continue;
  }

  const [sdk, commit] = await Promise.all([sdkVersion(sdkRelease), github<{ sha: string }>('bedrock-schemas', 'commits/' + tag)]);

  if (sdk?.gitHead !== commit.sha || !/^sha512-[a-zA-Z0-9+/]{86}==$/.test(sdk.dist?.integrity ?? '')) {
    await waiting(`Waiting for npm SDK ${sdkRelease} from the commit tagged ${tag}.`);
    continue;
  }

  additions[version] = {
    schemaTag: tag,
    schemaVersion: sdkRelease,
    schemaCommit: commit.sha,
    schemaIntegrity: sdk.dist!.integrity!,
    samplesTag: sampleTag,
    samplesSha256: sha256,
  };
  reviewedSdks.add(sdkRelease);
}

const versions = Object.keys(additions).sort(compareVersions);
const output = process.env.GITHUB_OUTPUT;

if (output) {
  await appendFile(output, 'updated=' + Boolean(versions.length) + '\n');
}

if (!versions.length) {
  console.info('No new Bedrock schema source pairs were found.');
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
      const baseline = ordered[index - 1] ?? ordered[index + 1];
      const diff = baseline ? await diffReleases(baseline, version) : undefined;

      summary.push(sources + ` ${audit.counts.newIssues} | ${diff ? diff.added.length + diff.changed.length + diff.removed.length : '—'} |`);

      if (audit.counts.newIssues || audit.counts.resolved) {
        if (output) {
          await appendFile(output, 'review=true\n');
        }

        console.warn('::warning::Review the Types audit findings for ' + version);
      }
    } catch (error) {
      const directory = path.join(reportsRoot, version);

      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'audit-error.txt'), String(error) + '\n');
      console.error(error);
      summary.push(sources + ' Review generation failure | — |');
      process.exitCode = 1;
    }
  }

  console.info(summary.join('\n'));

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  }
}
