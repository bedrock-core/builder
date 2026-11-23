import type { Coverage, Metadata, Problem, Resources } from './bedrock/types.ts';
import type { CheckedStates } from './compiler/types.ts';
import type { Release, ReleaseAsset, RendererProfile, SourceLock, Sources, VersionManifest } from './sources/types.ts';
import type { MappingSource } from './sources/types.ts';
import type { InputFile } from './sources/download.ts';
import type { AuditReport } from './audit.ts';
import type { PreparedRefresh, RefreshReport } from './pipeline.ts';
import { asError } from './json.ts';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cache, reports } from './paths.ts';
import { readAssetMaps } from '@bedrock-core/builder-bundler/assets';
import { auditDocuments } from './audit.ts';
import { prepareAssetRefresh } from './pipeline.ts';
import { bedrockResources, nativeResources } from './sources/pack.ts';
import { sourceJson, matchingGeyserRelease, resolveSourcePins } from './sources/pins.ts';
import { jsonBytes } from './sources/java.ts';
import { nativeAssets } from './bedrock/native.ts';
import { serializeJson } from './json.ts';
import { lockedInput } from './sources/download.ts';
import { exists } from '../../bedrock-types/src/files.ts';
import { buildAssetMaps } from './build.ts';
import { writeDistDiff } from './diff.ts';
import { writeDocuments } from './bedrock/documents.ts';
import { assetVersion, candidateInputs, compareVersions, readAssetInput, readAssetRelease, readReleases, registerAssetRelease, releaseChannel, releaseOutput, workspaceVersion, type AssetChannel } from './releases.ts';

interface ReleaseCandidate { tag: string; minecraft: string; archive: ReleaseAsset }

interface DefinitionChanges { added: string[]; removed: string[]; changed: string[] }

interface UpdatePlan { changed: boolean; regenerate: boolean; issue: boolean; reasons: string[] }

export class WaitingForArchive extends Error {}

export type CaptureStates = (target: { version: string; minecraft: string; metadata: Metadata }) => Promise<CheckedStates | undefined>;

export interface UpdateReport {
  schemaVersion: number; channel: AssetChannel; current: string; baselineVersion: string;
  candidate: { version: string; minecraft: string; tag: string; archive: InputFile };
  upstream: { java: VersionManifest['latest']; mappings?: MappingSource };
  changes: DefinitionChanges;
  unreleased: { branch: string; commit?: string; truncated: boolean; files: { filename: string; status: string }[] };
  audit: AuditReport; conversionCoverage: Coverage; proposedCoverage?: Coverage; newProblems: Problem[]; plan: UpdatePlan;
  requirements: string[]; generated?: RefreshReport; issue?: string; updated: boolean;
}

const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export const documentsChanged = (index: { files: Record<string, string>; pretty?: boolean }, documents: Resources): boolean => Object.keys(index.files).length !== documents.size
  || [...documents].some(([file, document]) => index.files[file] !== digest(serializeJson(document, index.pretty ?? false)));

const compare = (a: string, b: string): number => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);

  for (let i = 0; i < 4; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }

  return 0;
};

export function latestRelease(releases: Release[], channel: string, gameVersion?: string): ReleaseCandidate | undefined {
  if (!['stable', 'preview'].includes(channel)) {
    throw new Error('Unknown asset channel');
  }

  const [edition, year, drop] = (gameVersion ?? '').split('.').map(Number);
  const line = [edition, year, Math.floor(drop / 10) * 10].join('.');

  return releases.filter(value => !value.draft && /^v1\.\d+\.\d+\.\d+(?:-preview)?$/.test(value.tag_name)
    && (value.prerelease || value.tag_name.includes('preview') ? 'preview' : 'stable') === channel)
    .map(value => ({ tag: value.tag_name, minecraft: value.tag_name.replace(/^v/, '').replace(/-preview$/, ''),
      archive: value.assets?.find(asset => /-full\.zip$/.test(asset.name)) }))
    .filter(value => !gameVersion || (channel === 'preview'
      ? value.minecraft === gameVersion
      : value.minecraft.startsWith(line + '.') && compare(value.minecraft, gameVersion) <= 0))
    .filter((value): value is typeof value & { archive: ReleaseAsset } => value.archive?.browser_download_url?.startsWith(`https://github.com/Mojang/bedrock-samples/releases/download/${value.tag}/`) === true)
    .sort((a, b) => compare(b.minecraft, a.minecraft))[0];
}

export function changedDefinitions(before: Resources, after: Resources): DefinitionChanges {
  const flatten = (resources: Resources): Map<string, string> => {
    const native = nativeAssets(resources), values = new Map<string, string>();

    for (const kind of ['blocks', 'items', 'entities', 'models', 'textures'] as const) {
      for (const [id, value] of Object.entries(native[kind])) {
        values.set(kind + '/' + id, digest(JSON.stringify(value)));
      }
    }

    return values;
  };

  const left = flatten(before), right = flatten(after);

  return { added: [...right.keys()].filter(id => !left.has(id)).sort(), removed: [...left.keys()].filter(id => !right.has(id)).sort(),
    changed: [...right.keys()].filter(id => left.has(id) && left.get(id) !== right.get(id)).sort() };
}

export function updatePlan({ current, candidate, conversionVersion, audit, sourceChanged = false, requirements = [] }: { current: string; candidate: string; conversionVersion?: string; audit: { errors: Problem[]; gaps: Problem[] }; sourceChanged?: boolean; requirements?: string[] }): UpdatePlan {
  const changed = current !== candidate || sourceChanged;
  const needsConversion = conversionVersion !== candidate;

  return { changed, regenerate: changed && !needsConversion && !requirements.length && audit.errors.length === 0,
    issue: needsConversion || requirements.length > 0 || audit.errors.length > 0 || audit.gaps.length > 0,
    reasons: [...(needsConversion ? ['Matching Bedrock state and model conversion inputs are required before advancing the source pin.'] : []),
      ...requirements, ...(audit.errors.length ? ['Supplement references or documents require correction.'] : []), ...(audit.gaps.length ? ['New rendering relationships remain unresolved.'] : [])] };
}

/** Compare relationships and legal tuples, keeping existing gaps visible without counting them as regressions. */
export function newProblems(before: Problem[], after: Problem[]): Problem[] {
  function expand(problems: Problem[]) {
    return problems.flatMap(problem => problem.stateTuples?.map((states) => {
      const { kind, id, reason, file } = problem;

      return { kind, id, reason, ...(file === undefined ? {} : { file }), states };
    }) ?? [problem]);
  }

  const key = ({ kind, id, reason, file, states }: Problem): string => JSON.stringify([
    kind, id, reason, file, states && Object.entries(states).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  const count = (problem: Problem): number => problem.affectedStates ?? problem.missingStates ?? 1;

  const index = (problems: Problem[]): Map<string, Problem> => {
    const entries = new Map<string, Problem>();

    for (const problem of expand(problems)) {
      const id = key(problem), previous = entries.get(id);

      if (!previous || count(previous) < count(problem)) {
        entries.set(id, problem);
      }
    }

    return entries;
  };

  const known = index(before);

  return [...index(after)].filter(([id, problem]) => !known.has(id) || count(problem) > count(known.get(id)!))
    .map(([, problem]) => problem);
}

async function github<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('https://api.github.com' + endpoint, { ...options, headers: { 'Accept': 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}),
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bedrock-core-asset-maps', ...options.headers }, signal: AbortSignal.timeout(30000) });

  if (!response.ok) {
    throw new Error(`GitHub ${endpoint}: HTTP ${response.status}`);
  }

  return response.json();
}

export async function coverageIssue(report: UpdateReport, repository?: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !process.env.GH_TOKEN) {
    throw new Error('Coverage issue updates require a repository and GH_TOKEN');
  }

  const { channel } = report;
  const marker = `<!-- asset-maps:coverage:${channel} -->`, title = `Asset maps: ${channel} coverage`;
  const matches = await github<{ items: { number: number; body?: string }[] }>('/search/issues?q=' + encodeURIComponent(`repo:${repository} is:issue is:open in:title "${title}"`));
  const existing = matches.items.find(issue => issue.body?.includes(marker));
  const entries = report.newProblems.slice(0, 50).map(entry => `- \`${entry.id}\`: ${entry.reason}`).join('\n');
  const run = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const pending = report.unreleased.files.slice(0, 30).map(file => `- ${file.status}: \`${file.filename}\``).join('\n');
  const body = `${marker}\nSource: ${report.candidate.tag}. Current maps: ${report.current}.\n\n${report.plan.reasons.join('\n\n')}\n\nAdded: ${report.changes.added.length}; changed: ${report.changes.changed.length}; removed: ${report.changes.removed.length}.\n\n${entries}\n\n${pending ? 'Unreleased upstream rendering changes:\n\n' + pending : ''}\n\n${run ? `Full coverage and source delta: [workflow artifacts](${run}).` : 'The audit report contains the complete source delta and unresolved relationships.'}`;
  const issue = await github<{ html_url: string }>(`/repos/${repository}/issues${existing ? '/' + existing.number : ''}`, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) });

  return issue.html_url;
}

async function loadBaseline(version: string) {
  const release = await readAssetRelease(version);
  const output = releaseOutput(version);
  const index = join(output, 'index.json');

  if (!await exists(index)) {
    await buildAssetMaps({ version, output });
  }

  const [maps, upstream, coverageText] = await Promise.all([
    readAssetMaps(index), nativeResources({ version }), readFile(join(output, 'coverage.json'), 'utf8'),
  ]);
  const lock = maps.lock as SourceLock;

  if (maps.index.minecraft !== release.source.bedrock.minecraft || lock.upstream?.tag !== release.entry.samplesTag
    || lock.upstream?.archive?.sha256 !== release.entry.samplesSha256) {
    throw new Error('The generated baseline differs from the pinned release: ' + version);
  }

  const coverage: Coverage = JSON.parse(coverageText);

  return { ...release, output, maps, upstream, coverage };
}

function prepareCandidate(source: Sources, baselineDirectory: string, statesFile?: string) {
  const version = assetVersion(source.bedrock.tag);
  const directory = candidateInputs(version);

  return prepareAssetRefresh({
    sourceOverride: source, inputDirectory: directory, fallbackDirectory: baselineDirectory,
    statesFile: statesFile ?? join(directory, 'native-states.json'), output: releaseOutput(version),
  });
}

async function saveCandidate(source: Sources, baseline: Awaited<ReturnType<typeof loadBaseline>>, prepared: PreparedRefresh, write: boolean) {
  const version = assetVersion(source.bedrock.tag);
  const outputPath = releaseOutput(version);
  const result = await writeDocuments({ ...prepared, output: outputPath, pretty: baseline.maps.index.pretty ?? true });
  const generated: RefreshReport = { ...prepared.report, ...result, version, outputPath };

  await Promise.all([
    writeDistDiff(baseline.version, version, baseline.output, outputPath),
    writeFile(join(dirname(outputPath), 'audit.json'), JSON.stringify(prepared.audit, null, 2) + '\n'),
    writeFile(join(dirname(outputPath), 'build.json'), JSON.stringify(generated, null, 2) + '\n'),
  ]);

  return { generated, updated: write && await registerAssetRelease(source, prepared.inputs) };
}

export async function applySourcePin(source: Sources, baselineVersion: string, statesFile?: string) {
  const version = assetVersion(source.bedrock.tag);
  const releases = await readReleases();

  if (Object.hasOwn(releases, version)) {
    const existing = await readAssetRelease(version);

    if (!jsonBytes(existing.source).equals(jsonBytes(source))) {
      throw new Error('Asset Maps already has reviewed source pins for ' + version);
    }

    return buildAssetMaps({ version: version === await workspaceVersion() ? undefined : version, statesFile });
  }

  const baseline = await loadBaseline(baselineVersion);
  const prepared = await prepareCandidate(source, baseline.directory, statesFile);

  if (prepared.audit.redundant.length) {
    throw new Error('Remove redundant supplements before reviewing ' + version);
  }

  return saveCandidate(source, baseline, prepared, true);
}

async function discover({ write, channel, tag, gameVersion, captureStates }: {
  write: boolean; channel: AssetChannel; tag?: string; gameVersion?: string; captureStates?: CaptureStates;
}): Promise<UpdateReport> {
  const releases = tag
    ? [await sourceJson<Release>('https://api.github.com/repos/Mojang/bedrock-samples/releases/tags/' + encodeURIComponent(tag))]
    : await sourceJson<Release[]>('https://api.github.com/repos/Mojang/bedrock-samples/releases?per_page=100');
  const candidate = latestRelease(releases, channel, gameVersion);

  if (!candidate || !/^sha256:[a-f0-9]{64}$/.test(candidate.archive.digest)) {
    throw new WaitingForArchive('Waiting for a checksummed Samples archive for ' + (gameVersion ?? tag ?? channel) + '.');
  }

  const recorded = await readReleases();
  const baseVersion = Object.keys(recorded).filter(version => releaseChannel(version) === channel).sort(compareVersions).at(-1) ?? await workspaceVersion();
  const [baseline, mappings, java] = await Promise.all([
    loadBaseline(baseVersion),
    sourceJson<Release[]>('https://api.github.com/repos/GeyserMC/mappings-generator/releases?per_page=100'),
    sourceJson<VersionManifest>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
  ]);
  const version = assetVersion(candidate.tag);
  const archive = { url: candidate.archive.browser_download_url, sha256: candidate.archive.digest.slice(7) };
  const pair = matchingGeyserRelease(mappings, candidate.minecraft.split('.').slice(0, 3).join('.'));
  const branch = channel === 'preview' ? 'preview' : 'main';
  const delta = await github<{ commits?: { sha: string }[]; base_commit?: { sha: string }; files?: { filename: string; status: string }[] }>('/repos/Mojang/bedrock-samples/compare/' + encodeURIComponent(candidate.tag) + '...' + branch);
  const unreleased = { branch, commit: delta.commits?.at(-1)?.sha ?? delta.base_commit?.sha, truncated: (delta.files?.length ?? 0) >= 300,
    files: (delta.files ?? []).filter(file => /^(?:behavior_pack\/(?:blocks|items)|resource_pack\/(?:entity|models|textures)|metadata\/(?:json_schemas|vanilladata_modules))\/.+\.(?:json|png|tga)$/.test(file.filename)).map(file => ({ filename: file.filename, status: file.status })) };
  const alreadyPinned = Object.hasOwn(recorded, version);
  const changedArchive = archive.sha256 !== baseline.entry.samplesSha256;
  const upstream = changedArchive ? bedrockResources(await lockedInput(archive, cache, { extension: '.zip', maxBytes: 256 * 1024 * 1024 })) : baseline.upstream;
  const requirements: string[] = [];
  let proposed: PreparedRefresh | undefined;
  let pins: Sources | undefined;
  let checkedVersion = alreadyPinned ? candidate.minecraft : undefined;

  if (alreadyPinned) {
    const existing = version === baseline.version ? baseline : await readAssetRelease(version);

    if (recorded[version].samplesSha256 !== archive.sha256) {
      requirements.push('The Mojang archive differs from the reviewed source pin for ' + version + '.');
    }

    if (pair && pair.archive.sha256 !== existing.source.mappings.archive.sha256) {
      requirements.push('Geyser publishes a different mapping archive for this pinned Minecraft release. Review its coverage changes.');
    }
  } else {
    const directory = candidateInputs(version);
    const capture = join(directory, 'native-states.json');

    if (await exists(capture)) {
      try {
        const states: CheckedStates = JSON.parse(await readFile(capture, 'utf8'));

        checkedVersion = states.version;
      } catch (error) { requirements.push('The candidate state capture requires review: ' + asError(error).message); }
    }

    if (!pair) {
      requirements.push('A published Geyser mapping release for this Bedrock version is required.');
    }

    if (pair && checkedVersion !== candidate.minecraft && captureStates) {
      const metadata = upstream.get('metadata/mojang-blocks.json') as unknown as Metadata;
      const captured = await captureStates({ version, minecraft: candidate.minecraft, metadata });

      if (captured) {
        if (captured.version !== candidate.minecraft) {
          throw new Error('The native inventory does not match the Samples release');
        }

        await mkdir(directory, { recursive: true });
        await writeFile(capture, jsonBytes(captured));
        checkedVersion = captured.version;
      }
    }

    if (pair && checkedVersion === candidate.minecraft) {
      try {
        const profile: RendererProfile = JSON.parse((await readAssetInput(directory, 'renderer-profiles.json', baseline.directory)).toString('utf8'));

        if (profile.java !== pair.java) {
          throw new Error('The Java extractor and renderer profiles require review for Java ' + pair.java + '.');
        }

        pins = await resolveSourcePins({ current: baseline.source, bedrock: candidate.minecraft, channel, mappings: pair.version, java: pair.java });

        if (pins.bedrock.archive.sha256 !== archive.sha256 || pins.bedrock.archive.url !== archive.url) {
          throw new Error('The Mojang release changed during source discovery.');
        }

        if (profile.client !== pins.java.client.sha256) {
          throw new Error('The renderer profiles require review for the pinned Java client.');
        }

        proposed = await prepareCandidate(pins, baseline.directory, capture);

        if (proposed.audit.redundant.length) {
          requirements.push('The candidate has redundant supplements that require review.');
        }
      } catch (error) { requirements.push('The candidate inputs require review: ' + asError(error).message); }
    }
  }

  const changes = changedDefinitions(baseline.upstream, upstream);
  const nativeAudit = (resources: Resources, minecraft: string): AuditReport => auditDocuments({ index: { minecraft }, lock: {}, documents: new Map() }, resources);
  const sameRelease = alreadyPinned && version === baseVersion && !changedArchive;
  const baselineAudit = proposed || sameRelease ? auditDocuments(baseline.maps, baseline.upstream) : nativeAudit(baseline.upstream, baseline.maps.index.minecraft);
  const audit = proposed?.audit ?? (sameRelease ? baselineAudit : nativeAudit(upstream, candidate.minecraft));
  const problems = newProblems([...baselineAudit.errors, ...baselineAudit.gaps, ...baseline.coverage.gaps, ...baseline.coverage.issues],
    [...audit.errors, ...audit.gaps, ...(proposed?.coverage.gaps ?? []), ...(proposed?.coverage.issues ?? [])]);
  const plan = updatePlan({ current: alreadyPinned ? candidate.minecraft : baseline.maps.index.minecraft, candidate: candidate.minecraft,
    conversionVersion: checkedVersion, sourceChanged: !alreadyPinned, audit: { errors: audit.errors, gaps: alreadyPinned ? [] : problems }, requirements });

  if (!alreadyPinned && checkedVersion !== candidate.minecraft) {
    plan.reasons.push('Capture the exact Bedrock states at data/releases/' + version + '/native-states.json.');
  }

  if (unreleased.files.length || unreleased.truncated) {
    plan.issue = true;
    plan.reasons.push('Review the unreleased upstream file comparison for upcoming coverage work.');
  }

  const report: UpdateReport = {
    schemaVersion: 1, channel, current: baseline.maps.index.minecraft, baselineVersion: baseVersion,
    candidate: { version, minecraft: candidate.minecraft, tag: candidate.tag, archive },
    upstream: { java: java.latest, mappings: pair }, changes, unreleased, audit, conversionCoverage: baseline.coverage,
    proposedCoverage: proposed?.coverage, newProblems: problems, plan, requirements, updated: false,
  };

  if (plan.regenerate && proposed && pins) {
    Object.assign(report, await saveCandidate(pins, baseline, proposed, write));
  }

  return report;
}

export async function update({ write = false, publishIssue = false, output, channel, tag, gameVersion, captureStates }: {
  write?: boolean; publishIssue?: boolean; output?: string; channel?: AssetChannel; tag?: string; gameVersion?: string; captureStates?: CaptureStates;
} = {}): Promise<UpdateReport> {
  channel ??= releaseChannel(tag ? assetVersion(tag) : await workspaceVersion());
  output ??= join(reports, 'asset-maps-' + channel + (gameVersion ? '-' + gameVersion : '') + '-update.json');

  await mkdir(dirname(output), { recursive: true });
  let report: UpdateReport | undefined;

  try {
    report = await discover({ write, channel, tag, gameVersion, captureStates });

    if (publishIssue && report.plan.issue) {
      report.issue = await coverageIssue(report, process.env.GITHUB_REPOSITORY);
    }

    await writeFile(output, JSON.stringify(report, null, 2) + '\n');

    return report;
  } catch (error) {
    const details = error instanceof WaitingForArchive
      ? { status: 'waiting', reason: error.message }
      : { status: 'failed', error: asError(error).message };

    await writeFile(output, JSON.stringify({ ...report, schemaVersion: 1, ...details }, null, 2) + '\n');
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { 'write': { type: 'boolean' }, 'github': { type: 'boolean' }, 'channel': { type: 'string' }, 'tag': { type: 'string' }, 'game-version': { type: 'string' } },
  });

  if (values.channel !== undefined && values.channel !== 'stable' && values.channel !== 'preview') {
    throw new Error('Unknown asset channel: ' + values.channel);
  }

  const gameVersion = values['game-version'];

  if (gameVersion && (!/^1\.\d+\.\d+\.\d+$/.test(gameVersion) || !values.channel || values.tag)) {
    throw new Error('Provide a four-part BDS build and its channel when checking the matching Samples archive.');
  }

  try {
    const report = await update({ write: values.write, publishIssue: values.github, channel: values.channel, tag: values.tag, gameVersion });

    if (report.updated && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, 'updated=true\n');
    }

    if (report.plan.issue && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, 'coverage=true\n');
    }

    console.info(JSON.stringify({
      current: report.baselineVersion, candidate: report.candidate.version,
      updated: report.updated, ...report.plan, generated: report.generated, issueUrl: report.issue,
    }));

    if (process.env.GITHUB_STEP_SUMMARY) {
      const details = [`### Asset Maps ${report.candidate.version}`, '', ...report.plan.reasons.map(reason => '- ' + reason),
        ...(report.issue ? ['- [Coverage review](' + report.issue + ')'] : []), ''];

      await appendFile(process.env.GITHUB_STEP_SUMMARY, details.join('\n') + '\n');
    }
  } catch (error) {
    if (!(error instanceof WaitingForArchive)) {
      throw error;
    }

    console.info(error.message);

    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, '- ' + error.message + '\n');
    }
  }
}
