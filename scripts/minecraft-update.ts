import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { audit as auditMaps } from '../packages/asset-maps/src/audit.ts';
import { writeDocuments } from '../packages/asset-maps/src/bedrock/documents.ts';
import type { Coverage } from '../packages/asset-maps/src/bedrock/types.ts';
import { buildAssetMaps } from '../packages/asset-maps/src/build.ts';
import { writeDistDiff } from '../packages/asset-maps/src/diff.ts';
import { prepareAssetRefresh } from '../packages/asset-maps/src/pipeline.ts';
import { assetVersion, compareVersions, readAssetRelease, readReleases as readMapReleases, releaseChannel, releaseOutput } from '../packages/asset-maps/src/releases.ts';
import { WaitingForArchive, newProblems, update } from '../packages/asset-maps/src/update.ts';
import { auditRelease } from '../packages/bedrock-types/src/audit.ts';
import { diffReleases } from '../packages/bedrock-types/src/diff.ts';
import { readReleases as readTypeReleases, reportsRoot } from '../packages/bedrock-types/src/releases.ts';
import { captureNativeStates, type MinecraftTarget } from './minecraft-state-capture.ts';

type Game = Pick<MinecraftTarget, 'gameVersion' | 'gameChannel'>;
type Target = MinecraftTarget | { id: 'locked'; apiChannel: 'locked' };
type PackageName = 'bedrock-types' | 'asset-maps';
type Pin = { samplesTag: string };

interface Archive {
  file: string;
  version: string;
}

interface GenerationReport {
  packages: Record<string, Partial<Record<PackageName, Archive>>>;
  pending: string[];
  review: string[];
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const changed = (pins: Record<string, Pin>, baseline: Record<string, Pin>): string[] =>
  Object.keys(pins).filter(version => JSON.stringify(baseline[version]) !== JSON.stringify(pins[version]));

const run = (file: string, ...args: string[]): void => {
  execFileSync(process.execPath, [file, ...args], { stdio: 'inherit', env: { ...process.env, GITHUB_OUTPUT: '' } });
};

function matches(target: Target, pin: Pin): boolean {
  if (target.apiChannel === 'locked') {
    return false;
  }

  const tag = pin.samplesTag;

  return target.gameChannel === 'preview'
    ? tag === `v${target.gameVersion}-preview`
    : !tag.endsWith('-preview') && tag.startsWith(`v${target.engineVersion}.`)
      && compareVersions(tag.slice(3), target.gameVersion.slice(2)) <= 0;
}

function previous(pins: Record<string, Pin>, version: string): string | undefined {
  const versions = Object.keys(pins).filter(key => key !== version).sort(compareVersions);

  return versions.filter(key => releaseChannel(key) === releaseChannel(version) && compareVersions(key, version) < 0).at(-1)
    ?? versions.filter(key => compareVersions(key, version) < 0).at(-1)
    ?? versions.at(-1);
}

function basePins<T extends Pin>(base: string, pkg: PackageName): Record<string, T> {
  return JSON.parse(execFileSync('git', ['show', base + ':packages/' + pkg + '/releases.json'], { encoding: 'utf8' })) as Record<string, T>;
}

async function recordArchive(directory: string, output: string, name: PackageName, version: string): Promise<Archive> {
  const file = `bedrock-core-${name}-${version}.tgz`;

  await copyFile(path.join(output, file), path.join(directory, file));

  return { file, version };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'output': { type: 'string' }, 'base': { type: 'string' }, 'verify-pins': { type: 'boolean' }, 'target': { type: 'string', default: 'both' },
    'schema-tag': { type: 'string' }, 'samples-tag': { type: 'string' }, 'creator-tools': { type: 'string' }, 'baseline-maps': { type: 'string' },
  } });
  const output = values.output, base = values.base;

  assert(output && base && /^[a-f0-9]{40}$/.test(base), 'Provide an artifact directory and a baseline commit');
  assert(['both', 'types', 'asset-maps'].includes(values.target), 'Invalid package selection');

  if (values['samples-tag']) {
    assetVersion(values['samples-tag']);
  }

  const { include: targets } = JSON.parse(process.env.COMPATIBILITY_MATRIX ?? 'null') as { include: Target[] };
  const games = JSON.parse(process.env.MINECRAFT_GAMES ?? '[]') as Game[];
  const report: GenerationReport = { packages: {}, pending: [], review: [] };
  const archives: Record<PackageName, Map<string, Archive>> = { 'bedrock-types': new Map(), 'asset-maps': new Map() };

  const safe = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      report.review.push(label + ' failed. See the generation log.');
      console.error(label, error);
    }
  };

  const baselineTypes = basePins(base, 'bedrock-types');
  const baselineMaps = basePins(base, 'asset-maps');

  await mkdir(output, { recursive: true });

  if (values.target !== 'asset-maps' && !values['verify-pins']) {
    await safe('Bedrock Types discovery', async () => {
      const args = values['schema-tag']
        ? ['--tag', values['schema-tag']]
        : games.flatMap(game => [
            '--game', game.gameVersion + (game.gameChannel === 'preview' ? '-preview' : ''),
          ]);

      run('packages/bedrock-types/src/update.ts', ...args);
    });
  }

  if (values.target !== 'types' && !values['verify-pins']) {
    for (const game of values['samples-tag'] ? [{ gameChannel: releaseChannel(values['samples-tag']) }] : games) {
      const version = 'gameVersion' in game ? game.gameVersion : undefined;
      const label = version ?? values['samples-tag']!;
      const rows = targets.filter((row): row is MinecraftTarget =>
        row.apiChannel !== 'locked' && row.gameChannel === game.gameChannel && (!version || row.gameVersion === version));

      await safe('Asset Maps discovery for ' + label, async () => {
        try {
          const result = await update({
            write: true, channel: game.gameChannel, tag: values['samples-tag'], gameVersion: version,
            output: path.join(output, 'asset-maps-' + label + '.json'),
            captureStates: async ({ version, minecraft, metadata }) => {
              const target = rows.find(row => matches(row, { samplesTag: 'v1.' + version }));

              return target ? captureNativeStates(target, minecraft, metadata, path.join(output, version)) : undefined;
            },
          });

          const target = rows.some(row => matches(row, { samplesTag: result.candidate.tag }));

          if (!result.upstream.mappings || (result.plan.changed && !target)) {
            report.pending.push(`Asset Maps for ${label} is waiting for ${result.upstream.mappings ? 'a matching BDS and SDK row' : 'Geyser mappings'}.`);
          } else if (result.requirements.length || (result.plan.changed && !result.updated)) {
            report.review.push(`Asset Maps for ${label} needs review. ${result.plan.reasons.join(' ')}`);
          }
        } catch (error) {
          if (!(error instanceof WaitingForArchive)) {
            throw error;
          }

          report.pending.push(error.message);
        }
      });
    }
  }

  const types = await readTypeReleases(), maps = await readMapReleases();
  const changedTypes = changed(types, baselineTypes), changedMaps = changed(maps, baselineMaps);
  const selectedTypes = new Set<string>(changedTypes);
  const selectedMaps = new Set<string>(changedMaps);
  const selections: Record<string, Partial<Record<PackageName, string>>> = {};

  for (const target of targets) {
    const select = (pins: Record<string, Pin>): string | undefined =>
      Object.keys(pins).filter(version => matches(target, pins[version])).sort(compareVersions).at(-1);
    const typeVersion = target.apiChannel === 'locked'
      ? (await readJson<{ version: string }>('packages/bedrock-types/package.json')).version
      : select(types);
    const mapVersion = select(maps);

    selections[target.id] = { 'bedrock-types': typeVersion, 'asset-maps': mapVersion };

    if (typeVersion) {
      selectedTypes.add(typeVersion);
    }

    if (mapVersion) {
      selectedMaps.add(mapVersion);
    }

    if (target.apiChannel !== 'locked' && (!typeVersion || !mapVersion)) {
      report.pending.push(`${target.id}: waiting for ${[!typeVersion && 'Bedrock Types', !mapVersion && 'Asset Maps'].filter(Boolean).join(' and ')}.`);
    }
  }

  for (const [pkg, versions, pins] of [
    ['bedrock-types', changedTypes, types], ['asset-maps', changedMaps, maps],
  ] as const) {
    for (const version of versions) {
      if (!targets.some(target => matches(target, pins[version]))) {
        report.review.push(`${pkg} ${version} has no matching compatibility row yet.`);
      }
    }
  }

  for await (const input of glob('packages/asset-maps/data/releases/*/native-states.json')) {
    const version = path.basename(path.dirname(input));

    if (!Object.hasOwn(maps, version)) {
      report.review.push(`Asset Maps ${version} has a state capture awaiting release pins. See the Asset Maps discovery report.`);
    }
  }

  for (const version of selectedTypes) {
    await safe('Bedrock Types ' + version, async () => {
      const updated = changedTypes.includes(version);
      const audit = await auditRelease(version, updated ? values['creator-tools'] : undefined);
      const baseline = updated && previous(baselineTypes, version);

      if (audit.counts.newIssues || audit.counts.resolved) {
        report.review.push(`Bedrock Types ${version}: ${audit.counts.newIssues} new and ${audit.counts.resolved} resolved vanilla findings.`);
      }

      if (baseline) {
        await diffReleases(baseline, version);
      }

      run('packages/bedrock-types/src/pack.ts', version);
      archives['bedrock-types'].set(version, await recordArchive(output, path.join(reportsRoot, version), 'bedrock-types', version));
    });
  }

  for (const version of selectedMaps) {
    await safe('Asset Maps ' + version, async () => {
      const built = await buildAssetMaps({ version });

      await buildAssetMaps({ version, offline: true, check: true });
      const candidate = await auditMaps({ version, offline: true });
      const baseline = changedMaps.includes(version) && (Object.hasOwn(baselineMaps, version) ? version : previous(baselineMaps, version));

      if (baseline) {
        const baselinePath = values['baseline-maps'];

        assert(baselinePath, 'Provide the baseline Asset Maps checkout to compare coverage');
        const release = await readAssetRelease(baseline, path.join(baselinePath, 'releases.json'));
        const before = path.join(path.dirname(built.outputPath), 'baseline');
        const previous = await prepareAssetRefresh({
          sourceOverride: release.source, inputDirectory: release.directory, definitionsDirectory: path.join(baselinePath, 'definitions'),
        });
        const next = await readJson<Coverage>(path.join(built.outputPath, 'coverage.json'));
        const regressions = newProblems([...previous.audit.gaps, ...previous.coverage.gaps, ...previous.coverage.issues],
          [...candidate.gaps, ...next.gaps, ...next.issues]);

        await writeDocuments({ ...previous, output: before });
        await writeFile(path.join(path.dirname(built.outputPath), 'coverage-regressions.json'), JSON.stringify(regressions, null, 2) + '\n');
        await writeDistDiff(baseline, version, before, built.outputPath);

        if (regressions.length) {
          report.review.push(`Asset Maps ${version}: ${regressions.length} newly unresolved states or relationships.`);
        }
      }

      run('packages/asset-maps/src/pack.ts', version, '--offline');
      archives['asset-maps'].set(version, await recordArchive(output, path.dirname(releaseOutput(version)), 'asset-maps', version));
    });
  }

  for (const { id } of targets) {
    const versions = selections[id];

    report.packages[id] = {
      'bedrock-types': archives['bedrock-types'].get(versions['bedrock-types'] ?? ''),
      'asset-maps': archives['asset-maps'].get(versions['asset-maps'] ?? ''),
    };
  }

  await writeFile(path.join(output, 'packages.json'), JSON.stringify(report, null, 2) + '\n');
  const summary = [...report.review.map(note => '- Review: ' + note), ...report.pending.map(note => '- ' + note)].join('\n');

  if (process.env.GITHUB_STEP_SUMMARY && summary) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n' + summary + '\n');
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, 'review=' + Boolean(report.review.length) + '\n');
  }

  console.info(summary);
}

await main();
