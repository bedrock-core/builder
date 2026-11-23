import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeStateCapture } from '../packages/asset-maps/src/bedrock/states.ts';
import type { Metadata } from '../packages/asset-maps/src/bedrock/types.ts';
import type { CheckedBlock, CheckedStates } from '../packages/asset-maps/src/compiler/types.ts';

export interface MinecraftTarget {
  id: string;
  gameVersion: string;
  gameChannel: 'stable' | 'preview';
  engineVersion: string;
  apiChannel: 'stable' | 'rc' | 'beta';
  packages: Record<string, string>;
}

export function packModuleVersion(version: string): string {
  const parts = /^(\d+\.\d+\.\d+)(?:-(beta|rc)\..+)?$/.exec(version);

  assert(parts, 'Expected an exact Minecraft SDK version: ' + version);

  return parts[1] + (parts[2] === 'beta' ? '-beta' : '');
}

type CaptureRow = CheckedBlock | { blockId: string; unavailable: true };

export function readCapturedBlocks(log: string, metadata: Metadata, version: string) {
  const marker = '[Scripting] ASSET_MAP_STATES ';
  const rows = new Map<string, CheckedBlock>();
  const unavailable = new Set<string>();

  for (const line of log.split(/\r?\n/)) {
    const start = line.indexOf(marker);

    if (start < 0) {
      continue;
    }

    const row = JSON.parse(line.slice(start + marker.length)) as CaptureRow;

    if ('unavailable' in row) {
      assert(!rows.has(row.blockId) && !unavailable.has(row.blockId), 'Conflicting native rows for ' + row.blockId);
      unavailable.add(row.blockId);
      continue;
    }

    assert(!unavailable.has(row.blockId) && row.values.length, 'Missing native states for ' + row.blockId);
    const previous = rows.get(row.blockId);

    if (previous) {
      assert.deepEqual(row.keys, previous.keys, 'Inconsistent native keys for ' + row.blockId);
      previous.values.push(...row.values);
    } else {
      rows.set(row.blockId, row);
    }
  }

  assert.deepEqual([...rows.keys(), ...unavailable].sort(), metadata.data_items.map(block => block.name).sort(),
    'GameTest must report every Samples block');
  assert(rows.size, 'GameTest must capture a native state palette');

  const unavailableProperties = metadata.data_items.flatMap(({ name, properties }) => {
    const row = rows.get(name);
    const missing = row && properties?.map(property => property.name).filter(key => !row.keys.includes(key));

    return missing?.length ? [{ block: name, properties: missing }] : [];
  });
  const states = mergeStateCapture({ version, revision: '', blocks: [] }, { version, blocks: [...rows.values()] }, metadata);

  return { states, unavailable: [...unavailable].sort(), unavailableProperties };
}

/** Capture the Samples inventory in the matching runtime, recording the actual BDS build separately. */
export async function captureNativeStates(target: MinecraftTarget, sampleVersion: string, metadata: Metadata, reportDir: string): Promise<CheckedStates> {
  const runner = process.env.BUILDER_BDS_RUNNER;

  assert(runner, 'Set BUILDER_BDS_RUNNER to the installed bc-bds.mjs CLI');
  assert(target.gameChannel === 'preview'
    ? target.gameVersion === sampleVersion
    : target.engineVersion === sampleVersion.split('.').slice(0, 3).join('.'), 'The native capture must match the Samples track');

  const root = await mkdtemp(path.join(tmpdir(), 'builder-asset-map-states-'));
  const pack = path.join(root, 'packs', 'BP');
  const statesReport = path.join(reportDir, 'native-states-run.json');

  try {
    const scripts = path.join(pack, 'scripts');
    const structures = path.join(pack, 'structures', 'builder_asset_maps');
    const config = path.join(root, 'bds-runner.json');
    const blocks = metadata.data_items.map(({ name }) => name).sort();
    const manifest = {
      format_version: 2,
      header: { name: 'Builder Asset Maps state capture', description: 'Capture native states', uuid: 'dddb11e6-ff5c-47bc-a926-fc1c6631b23b', version: [1, 0, 0], min_engine_version: target.engineVersion.split('.').map(Number) },
      modules: [
        { type: 'data', uuid: '7988252a-09a4-447b-a924-6982d7d70c97', version: [1, 0, 0] },
        { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: 'ff74aafd-d668-4c28-a15c-b88926dee4a4', version: [1, 0, 0] },
      ],
      dependencies: ['@minecraft/server', '@minecraft/server-gametest'].map(module_name => ({
        module_name, version: packModuleVersion(target.packages[module_name]),
      })),
    };
    const source = await readFile(new URL('../fixtures/asset-map-states/main.ts', import.meta.url), 'utf8');

    await Promise.all([mkdir(scripts, { recursive: true }), mkdir(structures, { recursive: true }), mkdir(reportDir, { recursive: true })]);
    await Promise.all([
      writeFile(config, '{}\n'),
      writeFile(path.join(pack, 'manifest.json'), JSON.stringify(manifest)),
      writeFile(path.join(scripts, 'main.js'), 'const nativeBlocks = ' + JSON.stringify(blocks) + ';\n' + stripTypeScriptTypes(source)),
      cp(fileURLToPath(new URL('../fixtures/acceptance/packs/BP/structures/builder_acceptance/empty.mcstructure', import.meta.url)), path.join(structures, 'empty.mcstructure')),
    ]);
    const output = execFileSync(process.execPath, [runner, 'run', '--packs', path.join(root, 'packs'),
      '--tag', 'builder_asset_maps', '--expect-registered', '1', '--bds-version', target.gameVersion,
      '--bds-channel', target.gameChannel, '--config', config, '--instance', 'builder-asset-map-states', '--fresh',
      '--quiet', '--timeout', '180', '--json', statesReport,
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });

    console.info(output.trim());
    const result = JSON.parse(await readFile(statesReport, 'utf8')) as { bdsVersion: string };

    assert.equal(result.bdsVersion, target.gameVersion, 'State capture must run on the resolved BDS build');
    const log = /^\s*log: (.+)$/m.exec(output)?.[1].trim();

    assert(log && path.isAbsolute(log), 'BDS Runner must report the state capture log');
    const { states, unavailable, unavailableProperties } = readCapturedBlocks(await readFile(log, 'utf8'), metadata, sampleVersion);

    await writeFile(path.join(reportDir, 'native-states-inventory.json'), JSON.stringify({
      samples: sampleVersion, bds: target.gameVersion, channel: target.gameChannel, blocks: states.blocks.length, unavailable, unavailableProperties,
    }, null, 2) + '\n');

    return { ...states, capture: { bdsVersion: target.gameVersion, channel: target.gameChannel } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
