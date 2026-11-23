import type { Block, Catalog } from '../src/bedrock/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supplementBlockModels } from '../src/bedrock/supplements.ts';

test('fills missing chest geometry with native texture bindings and cardinal permutations', () => {
  const sides = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
  const textures = Object.fromEntries(sides.map(side => [side, 'chest_' + side]));
  const catalog: Catalog = {
    items: {}, entities: {}, models: {},
    textures: Object.fromEntries(Object.values(textures).map(alias => [alias, { paths: ['textures/' + alias], definition: 'textures/' + alias }])),
    blocks: Object.fromEntries(['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:ender_chest'].map(id => [id, {
      'format_version': '1.26.60', 'minecraft:block': { description: { identifier: id }, components: {} }, textures,
    }])),
  };

  supplementBlockModels(catalog);

  for (const type of ['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:ender_chest']) {
    const block = catalog.blocks[type];
    const key = block['minecraft:block'].components?.['minecraft:geometry'];

    assert.ok(typeof key === 'string');
    const model = catalog.models[key];
    const cube = model.geometry.bones[0].cubes?.[0];

    assert.deepEqual(cube?.size, [14, 14, 14]);
    assert.partialDeepStrictEqual(cube?.uv, { north: { material_instance: 'south' } });
    assert.ok(block.textures && typeof block.textures !== 'string');

    for (const slot of sides) {
      const alias = block.textures[slot];

      assert.ok(alias && catalog.textures[alias], slot);
    }

    assert.equal(block['minecraft:block'].permutations?.length, 4);
    assert.ok(model.provenance.warnings);
    assert.match(model.provenance.warnings[0], /approximation/);
  }
});

test('preserves authored geometry and permutations', () => {
  const authored: Block = { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:chest' }, components: { 'minecraft:geometry': 'geometry.authored' } }, 'textures': 'chest' };
  const converted: Block = { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:trapped_chest' },
    components: { 'minecraft:geometry': 'geometry.converted' }, permutations: [{ condition: 'q.block_state(\'direction\') == 2', components: { 'minecraft:transformation': { rotation: [0, 180, 0] } } }] }, 'textures': 'chest' };
  const catalog: Catalog = { blocks: { 'minecraft:chest': authored, 'minecraft:trapped_chest': converted }, models: {}, items: {}, entities: {}, textures: {} };

  supplementBlockModels(catalog);
  assert.equal(catalog.blocks['minecraft:chest'], authored);
  assert.equal(catalog.blocks['minecraft:trapped_chest'], converted);
  assert.deepEqual(catalog.models, {});
});
