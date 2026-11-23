import type { Coverage, GenerationSummary } from '../src/bedrock/types.ts';
import type { Sources } from '../src/sources/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeDocuments } from '../src/bedrock/documents.ts';
import { generationOptions } from '../src/pipeline.ts';
import { prepareAssetRefresh } from '../src/pipeline.ts';
import { serializeJson } from '../src/json.ts';
import { documentsChanged } from '../src/update.ts';

test('CLI accepts formatting and source-maintenance options and rejects invalid arguments', () => {
  assert.deepEqual(generationOptions(['--pretty', '--check']), { pretty: true, check: true });
  assert.deepEqual(generationOptions(['--compact']), { pretty: false });
  assert.deepEqual(generationOptions(['--version', '26.60.30-preview', '--offline']), { version: '26.60.30-preview', offline: true });
  assert.throws(() => generationOptions(['--version', '--check']), /requires an Asset Maps version/);
  assert.deepEqual(generationOptions([]), {});
  assert.deepEqual(generationOptions(['--offline', '--force-java', '--states', 'palette.json', '--compact']), {
    offline: true, forceJava: true, statesFile: 'palette.json', pretty: false,
  });
  assert.throws(() => generationOptions(['--states']), /requires a file/);
  assert.throws(() => generationOptions(['--states', '--check']), /requires a file/);
  assert.throws(() => generationOptions(['--pretty', '--compact']), /either/);
  assert.throws(() => generationOptions(['--wrong']), /Unknown/);
  assert.throws(() => Reflect.apply(serializeJson, undefined, [{}, 'true']), /boolean/);
});

test('pretty and compact output retain references, hashes and reproducibility through regeneration', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'asset-map-output-'));
  const prepared = await prepareAssetRefresh({ offline: true });
  const generate = (options: { output: string; check?: boolean; pretty?: boolean }): Promise<GenerationSummary> => writeDocuments({ ...prepared, ...options });

  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(join(output, 'obsolete.json'), '{}\n');
  await writeFile(join(output, 'index.json'), JSON.stringify({ files: { 'obsolete.json': '' } }));
  const first = await generate({ output });

  assert.equal(first.pretty, true);
  const coverage: Coverage = JSON.parse(await readFile(join(output, 'coverage.json'), 'utf8'));

  assert.equal(coverage.gaps.some(entry => entry.id === 'minecraft:acacia_button'), false);
  assert.equal(coverage.issues.some(entry => entry.id === 'minecraft:acacia_button'), false);
  const button = JSON.parse(await readFile(join(output, 'behavior_pack/blocks/minecraft/acacia_button.json'), 'utf8'))['minecraft:block'];

  assert.deepEqual(Object.keys(button.description.states), ['button_pressed_bit', 'facing_direction']);
  assert.ok(button.components['minecraft:geometry']);
  assert.equal(button.permutations.length, 11);
  assert.equal(coverage.fallbackBlockStates, 5409);
  assert.equal(coverage.fallbacks.some(entry => /shulker_box$|_head$|skull$|^minecraft:bed$/.test(entry.id)), false);
  assert.equal(coverage.gaps.every(entry => entry.reason === 'No Java source is mapped to this native Bedrock block'), true);
  assert.equal(coverage.fallbacks.find(entry => entry.id === 'minecraft:acacia_pressure_plate')?.affectedStates, 14);

  for (const id of ['acacia_wall_sign', 'acacia_standing_sign', 'acacia_hanging_sign', 'crimson_stairs', 'carrots', 'weeping_vines', 'campfire', 'frame', 'glow_frame', 'bed', 'chest', 'copper_chest', 'iron_chain', 'copper_chain', 'lightning_rod', 'dried_kelp_block', 'standing_banner', 'zombie_head', 'light_gray_shulker_box', 'copper_golem_statue', 'bamboo', 'fire', 'chorus_plant']) {
    assert.ok(Object.hasOwn(JSON.parse(await readFile(join(output, 'index.json'), 'utf8')).files, 'behavior_pack/blocks/minecraft/' + id + '.json'), id);
    assert.equal(coverage.issues.some(entry => entry.id === 'minecraft:' + id), false, id);
  }

  const frame = JSON.parse(await readFile(join(output, 'behavior_pack/blocks/minecraft/frame.json'), 'utf8'))['minecraft:block'];

  assert.deepEqual(Object.keys(frame.description.states), ['facing_direction', 'item_frame_map_bit']);
  assert.equal(coverage.gaps.some(entry => entry.id === 'minecraft:frame' || entry.id === 'minecraft:glow_frame'), false);

  for (const id of ['boat', 'chest_boat']) {
    const model = JSON.parse(await readFile(join(output, 'resource_pack/models/entity/' + id + '.geo.json'), 'utf8'));

    assert.equal(model['minecraft:geometry'][0].description.identifier, 'geometry.' + id);
  }

  const source = JSON.parse(await readFile(join(output, 'source-lock.json'), 'utf8'));
  const pins: Sources = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url), 'utf8'));

  assert.equal(source.conversion.renderers.java, pins.java.version);
  assert.deepEqual(source.conversion.renderers.client, pins.java.client);
  assert.match(source.conversion.renderers.revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(source), /InventivetalentDev|misode\/mcmeta|PackConverter.*https/);

  for (const id of ['powered_repeater', 'unpowered_repeater', 'scaffolding']) {
    const block = JSON.parse(await readFile(join(output, 'behavior_pack/blocks/minecraft/' + id + '.json'), 'utf8'))['minecraft:block'];

    assert.ok(block.components['minecraft:geometry']);
    assert.equal(coverage.issues.some(entry => entry.id === 'minecraft:' + id), false);
    assert.equal(Object.hasOwn(block.description.states ?? {}, 'direction'), false);
  }

  assert.equal(coverage.issues.some(entry => /external texture atlas|Texture is absent from upstream declarations/.test(entry.reason)), false);
  const trapdoor = JSON.parse(await readFile(join(output, 'behavior_pack/blocks/minecraft/bamboo_trapdoor.json'), 'utf8'))['minecraft:block'];

  for (const permutation of trapdoor.permutations) {
    assert.match(permutation.components['minecraft:geometry'], /^geometry\.bedrock_core\.asset_maps\.minecraft\.trapdoor\./);
  }

  assert.equal(coverage.gaps.some(entry => /leaves$|double.*slab|slab.*double/.test(entry.id)), false);

  for (const id of ['acacia_leaves', 'acacia_double_slab']) {
    const block = JSON.parse(await readFile(join(output, 'behavior_pack/blocks/minecraft/' + id + '.json'), 'utf8'))['minecraft:block'];

    assert.ok(block.components['minecraft:geometry']);
    assert.equal(block.permutations, undefined);
  }

  await assert.rejects(readFile(join(output, 'obsolete.json')), { code: 'ENOENT' });
  let before;

  for (const pretty of [true, false]) {
    if (!pretty) {
      await generate({ output, pretty });
    }

    const indexText = await readFile(join(output, 'index.json'), 'utf8');
    const index = JSON.parse(indexText), documents = new Map();

    assert.equal(index.pretty, pretty);
    assert.equal(indexText, serializeJson(index, pretty));

    for (const [file, digest] of Object.entries(index.files)) {
      const bytes = await readFile(join(output, file), 'utf8');
      const document = JSON.parse(bytes);

      documents.set(file, document);
      assert.equal(bytes, serializeJson(document, pretty), file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, file);
    }

    for (const file of ['coverage.json', 'source-lock.json']) {
      const bytes = await readFile(join(output, file), 'utf8');

      assert.equal(bytes, serializeJson(JSON.parse(bytes), pretty));
    }

    assert.equal(documentsChanged(index, documents), false);

    if (before) {
      assert.deepEqual(documents, before);
    }

    before = documents;
    assert.equal((await generate({ output, check: true })).pretty, pretty);
  }

  await assert.rejects(generate({ output, check: true, pretty: true }), /Stale asset map/);
  const preserved = await generate({ output });

  assert.equal(preserved.pretty, false);
});
