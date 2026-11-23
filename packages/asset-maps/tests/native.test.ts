import type { Document } from '../src/bedrock/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeAssets } from '../src/bedrock/native.ts';
import { readAssetMaps, composeAssetMaps } from '@bedrock-core/builder-bundler/assets';
import { fileURLToPath } from 'node:url';
import { nativeResources, parsePackJson } from '../src/sources/pack.ts';

test('retains vanilla-only metadata in source JSON while normalized assets expose supported render data', () => {
  const source = parsePackJson(JSON.stringify({
    'format_version': '1.26.50',
    'minecraft:block': {
      description: {
        identifier: 'minecraft:source_stairs',
        internal_vanilla_data: {
          block_id: 100,
          material: 'solid',
          block_archetype: { stair_block: { base_block: 'minecraft:source_base' } },
        },
      },
      components: { 'minecraft:geometry': 'geometry.source_stairs' },
    },
  }));
  const result = nativeAssets(new Map([['blocks/source_stairs.json', source]]));

  assert.partialDeepStrictEqual(source['minecraft:block']?.description, {
    internal_vanilla_data: { block_archetype: { stair_block: { base_block: 'minecraft:source_base' } } },
  });
  assert.deepEqual(result.blocks['minecraft:source_stairs']['minecraft:block'].description, { identifier: 'minecraft:source_stairs' });
  assert.equal(result.blocks['minecraft:source_stairs']['minecraft:block'].components?.['minecraft:geometry'], 'geometry.source_stairs');
});

test('selects compatible entity versions and resolves inherited native geometry without alias collisions', () => {
  const parent = { bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ size: [1, 1, 1] }] }] };
  const child = { bones: [{ name: 'body', cubes: [{ size: [2, 2, 2] }] }] };
  const entity = (model: string, minimum: string): Document => ({ 'format_version': '1.10.0', 'minecraft:client_entity': { description: { identifier: 'minecraft:test', min_engine_version: minimum, geometry: { default: model } } } });
  const resources = new Map<string, Document>([
    ['models/test.json', parsePackJson(JSON.stringify({ 'geometry.base': parent, 'geometry.child:geometry.base': child }))],
    ['models/native.json', { 'minecraft:geometry': [{ description: { identifier: 'minecraft:geometry.test' }, bones: [] }] }],
    ['entity/test.json', entity('geometry.child', '1.8.0')],
    ['entity/test_old.json', entity('geometry.base', '1.0.0')],
    ['entity/test_future.json', entity('unavailable', '1.27.0')],
  ]);
  const result = nativeAssets(resources, { target: '1.26.60' });

  assert.equal(result.entities['minecraft:test']['minecraft:client_entity'].description.geometry?.default, 'geometry.child');
  assert.equal(result.models['geometry.child'].geometry.bones[0].cubes?.length, 2);
  assert.equal(result.models['geometry.base'].geometry.bones[0].cubes?.length, 1);
  assert.ok(result.models['minecraft:geometry.test']);
  assert.equal(result.models.minecraft, undefined);
  assert.throws(() => nativeAssets(new Map([['models/cycle.json', parsePackJson('{"geometry.a:geometry.b":{},"geometry.b:geometry.a":{}}')]])), /cycle/);
});

test('retains native block permutations, carried textures, canonical IDs and item icons', () => {
  const resources = new Map<string, Document>([
    ['blocks.json', { legacy: { textures: 'ground', carried_textures: 'carried' } }],
    ['metadata/mojang-blocks.json', { data_items: [{ name: 'minecraft:modern', serialization_id: 'tile.legacy' }] }],
    ['metadata/mojang-items.json', { data_items: [{ name: 'minecraft:modern' }, { name: 'minecraft:tool', serialization_id: 'item.old_tool' }] }],
    ['blocks/native.json', { 'format_version': '1.26.0', 'minecraft:block': { description: { identifier: 'minecraft:modern' }, components: { 'minecraft:geometry': 'minecraft:geometry.cross' }, permutations: [{ condition: 'q.block_state(\'active\')', components: { 'minecraft:geometry': 'geometry.other' } }] } }],
    ['items/tool.json', { 'minecraft:item': { description: { identifier: 'minecraft:old_tool' }, components: { 'minecraft:icon': { textures: { default: 'tool', trim: 'decoration' } } } } }],
    ['textures/item_texture.json', { texture_data: { tool: { textures: 'textures/items/tool' }, decoration: { textures: 'textures/items/decoration' } } }],
  ]);
  const result = nativeAssets(resources);

  assert.equal(result.blocks['minecraft:modern'].carried_textures, 'carried');
  assert.equal(result.blocks['minecraft:modern'].textures, 'ground');
  assert.equal(result.blocks['minecraft:modern']['minecraft:block'].permutations?.[0].components['minecraft:geometry'], 'geometry.other');
  assert.deepEqual(result.items['minecraft:modern'].block, { id: 'minecraft:modern' });
  assert.deepEqual(result.items['minecraft:tool'].textures, { default: { id: 'item:tool' }, trim: { id: 'item:decoration' } });
  assert.equal(result.items['minecraft:old_tool'], undefined);
});

test('resolves vanilla item variants and native relationships from final supplements and the pinned archive', async () => {
  const catalog = composeAssetMaps(await readAssetMaps(fileURLToPath(new URL('../dist/index.json', import.meta.url))), await nativeResources({ offline: true }));
  const { items } = catalog;

  assert.ok(items);

  function itemPath(id: string): readonly string[] {
    const texture = items?.[`minecraft:${id}`].textures?.default;

    assert.ok(texture, id);

    return catalog.textures[texture.id].paths;
  }

  assert.deepEqual(itemPath('totem_of_undying'), ['textures/items/totem']);
  assert.deepEqual(itemPath('diamond_sword'), ['textures/items/diamond_sword']);
  assert.deepEqual(itemPath('wooden_sword'), ['textures/items/wood_sword']);
  assert.deepEqual(itemPath('water_bucket'), ['textures/items/bucket_water']);
  assert.equal(itemPath('bucket')[0], 'textures/items/bucket_empty');
  assert.deepEqual(itemPath('black_dye'), ['textures/items/dye_powder_black_new']);
  assert.deepEqual(itemPath('ink_sac'), ['textures/items/dye_powder_black']);
  assert.equal(catalog.entities['minecraft:zombie']['minecraft:client_entity'].description.geometry?.default, 'geometry.zombie.v1.8');
  const sheep = catalog.entities['minecraft:sheep']['minecraft:client_entity'].description.geometry?.default;

  assert.ok(sheep && catalog.models[sheep]);
  assert.partialDeepStrictEqual(catalog.blocks['minecraft:red_shrub']['minecraft:block'].components?.['minecraft:geometry'], { identifier: 'minecraft:geometry.cross' });
  assert.partialDeepStrictEqual(catalog.blocks['minecraft:grass_block'].textures, { up: 'grass_top' });
  assert.ok(catalog.blocks['minecraft:iron_chain']);

  for (const [id, item] of Object.entries(items)) {
    for (const ref of Object.values(item.textures ?? {})) {
      assert.ok(catalog.textures[ref.id], `${id} -> ${ref.id}`);
    }

    if (item.block) {
      assert.ok(catalog.blocks[item.block.id], `${id} -> ${item.block.id}`);
    }
  }
});

test('rejects invalid checked item mappings and variant indices', () => {
  const resources = new Map<string, Document>([
    ['metadata/mojang-items.json', { data_items: [{ name: 'minecraft:test' }] }],
    ['textures/item_texture.json', { texture_data: { variants: { textures: ['textures/items/one'] } } }],
  ]);

  assert.throws(() => nativeAssets(resources, { bindings: { items: { 'minecraft:test': { default: { alias: 'variants', index: 2 } } } } }), /texture index/);
  assert.throws(() => nativeAssets(resources, { bindings: { items: { 'minecraft:unknown': { default: 'item:variants' } } } }), /Unknown native item/);
  resources.set('items/test.json', parsePackJson('{"minecraft:item":{"description":{"identifier":"minecraft:test"},"components":{"minecraft:icon":"variants"}}}'));
  assert.throws(() => nativeAssets(resources, { bindings: { items: { 'minecraft:test': { default: 'item:missing' } } } }), /Missing native item/);
});
