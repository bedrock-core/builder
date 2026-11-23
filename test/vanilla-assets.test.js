import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { generateVanillaAssets, readAssetMaps, composeAssetMaps, archiveResources } from '../packages/bundler/src/vanilla.ts';
import { readNativePacks } from '../packages/bundler/src/vanilla/pack.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, document) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-native-assets-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const file = 'behavior_pack/blocks/minecraft/example.json';
  const bytes = JSON.stringify(document);

  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
  await writeFile(path.join(root, 'source-lock.json'), JSON.stringify({ schemaVersion: 1, minecraft: '1.26.60.30' }));
  const index = path.join(root, 'index.json');

  await writeFile(index, JSON.stringify({ schemaVersion: 1, minecraft: '1.26.60.30', files: { [file]: hash(bytes) } }));

  return { root, file, index };
}

test('native components and permutations override supplement values without losing missing fields', async (t) => {
  const supplement = { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:example' },
    components: { 'minecraft:geometry': 'minecraft:geometry.full_block', 'minecraft:light_emission': 7 },
    permutations: [{ condition: 'q.block_state(\'lit\') == 1', components: { 'minecraft:light_emission': 10 } }] } };
  const { index } = await fixture(t, supplement);
  const authored = { 'format_version': '1.26.50', 'minecraft:block': { description: { identifier: 'minecraft:example' },
    components: { 'minecraft:light_emission': 1 }, permutations: [{ condition: 'q.block_state(\'lit\') == 1', components: { 'minecraft:light_emission': 2 } }] } };
  const upstream = new Map([['blocks/example.json', authored]]);
  const before = JSON.stringify(authored), catalog = composeAssetMaps(await readAssetMaps(index), upstream);
  const definition = catalog.blocks['minecraft:example']['minecraft:block'];

  assert.equal(catalog.schemaVersion, 2);
  assert.equal(definition.components['minecraft:geometry'], 'minecraft:geometry.full_block');
  assert.equal(definition.components['minecraft:light_emission'], 1);
  assert.deepEqual(definition.permutations.map(value => value.components['minecraft:light_emission']), [2]);
  assert.equal(catalog.blocks['minecraft:example'].format_version, '1.26.50');
  assert.equal(JSON.stringify(authored), before);
});
test('map document hashes and package boundaries are checked before composition', async (t) => {
  const { root, file, index } = await fixture(t, { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:example' }, components: {} } });

  await writeFile(path.join(root, file), '{}');
  await assert.rejects(readAssetMaps(index), /hash mismatch/);
  await writeFile(index, JSON.stringify({ schemaVersion: 1, minecraft: '1.26.60.30', files: { 'resource_pack/../../outside.json': hash('{}') } }));
  await assert.rejects(readAssetMaps(index), /leaves the package/);
});
test('incompatible targets return before fetching an upstream archive', async (t) => {
  const { index } = await fixture(t, {});
  const original = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = () => {
    calls++;
    throw new Error('Unexpected download');
  };

  t.after(() => {
    globalThis.fetch = original;
  });
  const result = await generateVanillaAssets({ mapsIndex: index, targetVersion: '1.26.70' });

  assert.equal(result.catalog, undefined);
  assert.match(result.unavailable, /1\.26\.60\.30/);
  assert.equal(calls, 0);
});

function zip(name, text) {
  const file = Buffer.from(name), content = Buffer.from(text), compressed = deflateRawSync(content);
  let crc = 0xffffffff;

  for (const byte of content) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }

  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);

  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(file.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(file.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + compressed.length, 16);

  return Buffer.concat([local, file, compressed, central, file, end]);
}

test('large compressed native JSON streams finish under Node 26 and unsafe member paths are rejected', { timeout: 2000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-native-zip-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'samples.zip');

  await writeFile(file, zip('resource_pack/blocks.json', JSON.stringify({ note: 'x'.repeat(512 * 1024), example: { textures: 'stone' } })));
  const resources = await archiveResources(file);

  assert.equal(resources.get('blocks.json').example.textures, 'stone');
  await writeFile(file, zip('resource_pack/models/../escape.json', '{}'));
  await assert.rejects(archiveResources(file), /invalid|member|relative path/i);
  assert.equal((await readFile(file)).length > 0, true);
});

test('local native inputs accept samples roots and merge only compatible vanilla layers', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-native-stack-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const write = async (name, value) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), JSON.stringify(value));
  };

  await write('samples/resource_pack/blocks.json', { stone: { textures: 'stone' } });
  await write('samples/behavior_pack/items/example.json', { 'minecraft:item': { description: { identifier: 'minecraft:example' }, components: {} } });
  await write('samples/metadata/vanilladata_modules/mojang-items.json', { data_items: [{ name: 'minecraft:example' }] });
  const samples = await readNativePacks(path.join(root, 'samples'), '1.26.60');

  assert.ok(samples.has('items/example.json'));
  assert.ok(samples.has('metadata/mojang-items.json'));
  await write('layers/vanilla/textures/terrain_texture.json', { texture_data: { base: { textures: 'textures/base' } } });
  await write('layers/vanilla_1.26.50/textures/terrain_texture.json', { texture_data: { added: { textures: 'textures/added' } } });
  await write('layers/vanilla_1.26.70/textures/terrain_texture.json', { texture_data: { future: { textures: 'textures/future' } } });
  const layers = await readNativePacks(path.join(root, 'layers'), '1.26.60');

  assert.deepEqual(Object.keys(layers.get('textures/terrain_texture.json').texture_data).sort(), ['added', 'base']);
});
