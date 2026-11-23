import type { Bindings, Components, Definition, Document, GeneratedDocuments, Resources, StateValue } from '../src/bedrock/types.ts';
import type { CompiledModelSource, ModelApplication } from '../src/compiler/types.ts';
import type { CanonicalInverse, InverseRow } from '../src/compiler/inverse.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryFaces } from '../src/bedrock/geometry.ts';
import { faceCube, supplementDocuments as exportDocuments } from '../src/bedrock/documents.ts';
import { auditDocuments } from '../src/audit.ts';
import { composeAssetMaps, type AssetMapDocuments } from '@bedrock-core/builder-bundler/assets';
import { Quat } from '../src/compiler/math.ts';

const close = (actual: readonly number[], expected: readonly number[]): void => {
  assert.equal(actual.length, expected.length);

  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5, `${i}: ${actual[i]} != ${expected[i]}`);
  }
};

function fixtureInverse(compiled: CompiledModelSource): CanonicalInverse {
  const blocks = compiled.blocks.map(block => ({
    id: block.id, keys: block.keys, domains: block.domains,
    rows: block.indices.map((index, i): InverseRow => {
      const values: StateValue[] = [];

      for (let at = block.keys.length - 1; at >= 0; at--) {
        values[at] = block.domains[at][index % block.domains[at].length];
        index = Math.floor(index / block.domains[at].length);
      }

      const choice = compiled.choices[block.choices[i]][0];
      const row = { values, java: choice?.java ?? block.id, properties: {}, sources: 1 };

      return choice ? { ...row, program: choice.program } : { ...row, failure: { kind: 'missing', reason: 'Mapped Java model geometry is missing' } };
    }),
  })).sort((a, b) => a.id.localeCompare(b.id));

  return { schemaVersion: 1, source: compiled.source, nativeRevision: 'fixture', defaults: { sha256: '0'.repeat(64) }, blocks };
}

function supplementDocuments(compiled: CompiledModelSource, resources: Resources, bindings: Bindings, options?: Parameters<typeof exportDocuments>[3]): GeneratedDocuments {
  return exportDocuments(compiled, resources, bindings, { inverse: fixtureInverse(compiled), ...options });
}

function blockDefinition(files: Resources, file: string): Definition {
  const block = files.get(file)?.['minecraft:block'];

  assert.ok(block, file);

  return block;
}

const componentsOf = (block: Definition): (Components | undefined)[] => [block.components, ...block.permutations?.map(value => value.components) ?? []];

test('native face export preserves geometry corners and their associated UVs under arbitrary rotations', () => {
  for (const rotation of [[0, 0, 0], [0, 90, 0], [90, 0, 0], [23, 31, -17], [-90, 90, 0]]) {
    const q = Quat.fromEuler({ x: rotation[0], y: rotation[1], z: rotation[2] });
    const u = Quat.rotateVector(q, { x: 0.7, y: 0, z: 0 }), v = Quat.rotateVector(q, { x: 0, y: 0.3, z: 0 });
    const packed = [0.2, 0.1, 0.7, u.x, u.y, u.z, v.x, v.y, v.z, 0.125, 0.25, 0.5, -0.125, 0, -1, 1, 0];
    const cube = faceCube(packed, 'surface');
    const faces = geometryFaces({ description: { identifier: 'geometry.fixture', texture_width: 16, texture_height: 16 }, bones: [{ name: 'root', cubes: [cube] }] });

    assert.equal(faces.length, 1);
    const face = faces[0];

    close(Object.values(face.origin), [(packed[0] + u.x - 0.5) * 16, (packed[1] + u.y) * 16, (0.5 - packed[2] - u.z) * 16]);
    close(Object.values(face.u), [-u.x * 16, -u.y * 16, u.z * 16]);
    close(Object.values(face.v), [v.x * 16, v.y * 16, -v.z * 16]);
    close(face.uv, [0.625, 0.125, -0.5, 0.125]);
  }
});

const fixture = (): CompiledModelSource => ({ schemaVersion: 1, provider: 'fixture', source: { bedrock: '1.26.60.30', java: '26.3', mappings: 'fixture', revision: 'fixture' },
  textures: ['textures/blocks/test'], materials: [{ texture: 0, method: 'opaque' }],
  geometries: [{ faces: [[0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1, 0]], boxes: [] }], models: [{ name: 'test', geometry: 0, materials: [0], occluders: [] }],
  groups: [[[0, 0, 0, 0, 1]]], programs: [[0]], choices: [[{ program: 0, extra: {}, java: 'minecraft:test' }]], blocks: [{ id: 'minecraft:test', keys: ['axis'], domains: [['x', 'y']], indices: [0, 1], choices: [0, 0] }] });
const resources = (): Resources => new Map<string, Document>([
  ['textures/terrain_texture.json', { texture_data: { test: { textures: 'textures/blocks/test' } } }],
  ['textures/item_texture.json', { texture_data: { renamed: { textures: 'textures/items/test' } } }],
  ['metadata/mojang-items.json', { data_items: [{ name: 'minecraft:example' }] }],
]);

const variantFixture = (): CompiledModelSource => {
  const compiled = fixture();

  compiled.geometries.push(structuredClone(compiled.geometries[0]));
  compiled.geometries[1].faces[0][0] = 0.25;
  compiled.models.push({ ...compiled.models[0], geometry: 1 });
  compiled.groups.push([[1, 0, 0, 0, 1]]);
  compiled.programs.push([1]);
  compiled.choices.push([{ ...compiled.choices[0][0], program: 1 }]);
  compiled.blocks[0] = { id: 'minecraft:test', keys: ['minecraft:axis', 'powered_bit'], domains: [['x', 'y'], [false, true]], indices: [0, 1, 2, 3], choices: [0, 0, 1, 1] };

  return compiled;
};

test('shared geometry names use block shapes and relevant native states without material ownership', () => {
  const compiled = variantFixture();

  compiled.blocks[0].id = 'minecraft:oak_test';
  compiled.blocks.unshift({ ...compiled.blocks[0], id: 'minecraft:bamboo_test' });
  const result = supplementDocuments(compiled, resources(), {});
  const models = [...result.files.keys()].filter(file => file.includes('/models/')).sort();

  assert.deepEqual(models, ['resource_pack/models/blocks/minecraft/test/axis_x.geo.json', 'resource_pack/models/blocks/minecraft/test/axis_y.geo.json']);
  const definition = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/oak_test.json');
  const shared = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/bamboo_test.json');

  assert.deepEqual(shared.permutations, definition.permutations);
  assert.deepEqual(componentsOf(definition).map(value => value?.['minecraft:geometry']), ['geometry.bedrock_core.asset_maps.minecraft.test.axis_x', 'geometry.bedrock_core.asset_maps.minecraft.test.axis_y']);
  assert.deepEqual(Object.keys(definition.permutations?.[0].components['minecraft:material_instances'] ?? {}), ['north']);
  compiled.blocks.reverse();
  const reversed = supplementDocuments(compiled, resources(), {});

  assert.deepEqual([...reversed.files].sort(), [...result.files].sort());
  const constant = supplementDocuments(fixture(), resources(), {});

  assert.ok(constant.files.has('resource_pack/models/blocks/minecraft/test.geo.json'));
});

test('bamboo and acacia trapdoors reference the same generic trapdoor geometry', () => {
  const compiled = variantFixture();

  compiled.blocks[0] = { ...compiled.blocks[0], id: 'minecraft:acacia_trapdoor', keys: ['direction', 'open_bit'], domains: [[0, 1], [false, true]] };
  compiled.blocks.push({ ...compiled.blocks[0], id: 'minecraft:bamboo_trapdoor' });
  const result = supplementDocuments(compiled, resources(), {});

  for (const wood of ['acacia', 'bamboo']) {
    const block = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/' + wood + '_trapdoor.json');

    assert.deepEqual(componentsOf(block).map(value => value?.['minecraft:geometry']), ['geometry.bedrock_core.asset_maps.minecraft.trapdoor.direction_0', 'geometry.bedrock_core.asset_maps.minecraft.trapdoor.direction_1']);
  }

  assert.deepEqual([...result.files.keys()].filter(value => value.includes('/models/')).sort(), ['resource_pack/models/blocks/minecraft/trapdoor/direction_0.geo.json', 'resource_pack/models/blocks/minecraft/trapdoor/direction_1.geo.json']);
});

test('shared models with unrelated block names use geometric names', () => {
  for (const empty of [false, true]) {
    const compiled = fixture();

    compiled.blocks = ['minecraft:alpha', 'minecraft:beta'].map(id => ({ ...compiled.blocks[0], id }));

    if (empty) {
      compiled.geometries[0].faces = [];
    }

    const result = supplementDocuments(compiled, resources(), {});
    const shape = empty ? 'empty' : 'plane';

    assert.ok(result.files.has('resource_pack/models/blocks/minecraft/' + shape + '.geo.json'));

    for (const id of ['alpha', 'beta']) {
      assert.equal(blockDefinition(result.files, 'behavior_pack/blocks/minecraft/' + id + '.json').components?.['minecraft:geometry'], 'geometry.bedrock_core.asset_maps.minecraft.' + shape);
    }
  }
});

test('geometries selected by overlapping state value sets retain distinct readable names', () => {
  const compiled = variantFixture();

  compiled.blocks[0].choices = [0, 1, 1, 0];
  const result = supplementDocuments(compiled, resources(), {});

  assert.deepEqual([...result.files.keys()].filter(file => file.includes('/models/')).sort(), [
    'resource_pack/models/blocks/minecraft/test/axis_x__powered_bit_false.geo.json',
    'resource_pack/models/blocks/minecraft/test/axis_x__powered_bit_true.geo.json',
  ]);
});

test('state names omit repeated block and state-family prefixes', () => {
  const compiled = variantFixture();

  compiled.blocks[0].keys = ['test_side_east', 'test_side_west'];
  compiled.blocks[0].choices = [0, 1, 1, 0];
  const result = supplementDocuments(compiled, resources(), {});

  assert.deepEqual([...result.files.keys()].filter(file => file.includes('/models/')).sort(), [
    'resource_pack/models/blocks/minecraft/test/side_east_x__west_false.geo.json',
    'resource_pack/models/blocks/minecraft/test/side_east_x__west_true.geo.json',
  ]);
});

test('texture aliases use texture paths or item IDs, reuse existing aliases and avoid name collisions', () => {
  const upstream = resources();

  upstream.set('textures/terrain_texture.json', { texture_data: {
    variants: { textures: ['textures/blocks/test', 'textures/blocks/other'] },
    bedrock_core_asset_maps_blocks_test: { textures: 'textures/blocks/reserved' },
  } });
  upstream.set('textures/item_texture.json', { texture_data: {
    variants: { textures: ['textures/items/other', 'textures/items/test'] },
    bedrock_core_asset_maps_minecraft_example: { textures: 'textures/items/reserved' },
  } });
  const binding = { default: { alias: 'variants', index: 1 } };
  const result = supplementDocuments(fixture(), upstream, { items: { 'minecraft:z_example': binding, 'minecraft:example': binding } });

  assert.deepEqual(result.files.get('resource_pack/textures/terrain_texture.json')?.texture_data, { bedrock_core_asset_maps_blocks_test_2: { textures: 'textures/blocks/test' } });
  assert.deepEqual(result.files.get('resource_pack/textures/item_texture.json')?.texture_data, { bedrock_core_asset_maps_minecraft_example_2: { textures: 'textures/items/test' } });

  for (const id of ['example', 'z_example']) {
    assert.equal(result.files.get('behavior_pack/items/minecraft/' + id + '.json')?.['minecraft:item']?.components?.['minecraft:icon']?.textures?.default, 'bedrock_core_asset_maps_minecraft_example_2');
  }

  const reused = supplementDocuments(fixture(), resources(), { items: { 'minecraft:example': { default: 'textures/items/test' } } });

  assert.equal(reused.files.has('resource_pack/textures/item_texture.json'), false);
  assert.equal(reused.files.get('behavior_pack/items/minecraft/example.json')?.['minecraft:item']?.components?.['minecraft:icon']?.textures?.default, 'renamed');
  const preferred = resources();
  const terrain = preferred.get('textures/terrain_texture.json')?.texture_data;

  assert.ok(terrain);
  terrain.a_decoy = { textures: 'textures/blocks/test' };
  const block = blockDefinition(supplementDocuments(fixture(), preferred, {}).files, 'behavior_pack/blocks/minecraft/test.json');

  assert.equal(block.components?.['minecraft:material_instances']?.north.texture, 'test');
});

test('authored geometry can override a generated model by its readable identifier', () => {
  const file = 'resource_pack/models/blocks/minecraft/test.geo.json';
  const authored = { 'format_version': '1.16.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.bedrock_core.asset_maps.minecraft.test', texture_width: 16, texture_height: 16 }, bones: [{ name: 'root', cubes: [] }] }] };
  const result = supplementDocuments(fixture(), resources(), {}, { definitions: new Map([[file, authored]]) });

  assert.deepEqual(result.files.get(file), authored);
  assert.deepEqual(auditDocuments({ index: { minecraft: '1.26.60.30' }, lock: {}, documents: result.files }, resources()).errors, []);
});

test('exports only missing Bedrock documents, preserves upstream entity definitions and uses modern item icons', () => {
  const upstream = resources();
  const entity = { 'format_version': '1.8.0', 'minecraft:client_entity': { description: { identifier: 'minecraft:example', textures: { default: 'textures/entity/example' }, geometry: {} } } };

  upstream.set('entity/example.entity.json', entity);
  const result = supplementDocuments(fixture(), upstream, { items: { 'minecraft:example': { default: 'item:renamed' } } });

  assert.equal(result.coverage.generatedBlockStates, 2);
  assert.equal([...result.files.keys()].some(file => file.includes('/entity/')), false);
  const item = result.files.get('behavior_pack/items/minecraft/example.json');

  assert.deepEqual(item?.['minecraft:item']?.components, { 'minecraft:icon': { textures: { default: 'renamed' } } });
  const maps: AssetMapDocuments = { index: { schemaVersion: 1, minecraft: '1.26.60.30', files: {} }, lock: {}, documents: result.files, inputs: [] };

  assert.deepEqual(composeAssetMaps(maps, upstream).entities['minecraft:example'], entity);
  assert.deepEqual(auditDocuments(maps, upstream).errors, []);
});

test('upstream geometry and icon declarations remove obsolete supplements', () => {
  const upstream = resources();

  upstream.set('blocks/test.json', { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:test' }, components: { 'minecraft:geometry': 'minecraft:geometry.full_block' } } });
  upstream.set('items/example.json', { 'format_version': '1.26.60', 'minecraft:item': { description: { identifier: 'minecraft:example' }, components: { 'minecraft:icon': { textures: { default: 'renamed' } } } } });
  assert.equal(supplementDocuments(fixture(), upstream, { items: { 'minecraft:example': { default: 'item:renamed' } } }).files.size, 0);
});

test('exports canonical source rotations using only the native fields needed to select them', () => {
  const compiled = fixture();

  compiled.groups = [180, 0].flatMap(pitch => [90, 270, 0, 180].map((yaw): ModelApplication[] => [[0, pitch, yaw, 0, 1]]));
  compiled.programs = compiled.groups.map((_, index) => [index]);
  compiled.choices = [[0, 1, 2, 3], [4, 5, 6, 7]].map(programs => programs.map(program => ({ program, extra: {}, java: 'minecraft:test' })));
  compiled.blocks[0] = { id: 'minecraft:test', keys: ['button_pressed_bit', 'facing_direction'], domains: [[false], [0, 1]], indices: [0, 1], choices: [0, 1] };
  const inverse = fixtureInverse(compiled);

  inverse.blocks[0].rows[0].program = 2;
  inverse.blocks[0].rows[1].program = 6;
  const result = supplementDocuments(compiled, resources(), {}, { inverse });

  assert.equal(result.coverage.generatedBlockStates, 2);
  assert.deepEqual(result.coverage.gaps, []);
  assert.deepEqual(result.coverage.issues, []);
  const block = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/test.json');

  assert.deepEqual(Object.keys(block.description.states ?? {}), ['facing_direction']);
  assert.equal(block.permutations?.length, 1);

  for (const choices of compiled.choices) {
    choices.reverse();
  }

  assert.deepEqual([...supplementDocuments(compiled, resources(), {}, { inverse }).files].sort(), [...result.files].sort());
});

test('Java weighted yaw alternatives use the same base model without adding native states', () => {
  const compiled = fixture();

  compiled.groups[0] = [[0, 0, 90, 0, 1], [0, 0, 0, 0, 3], [0, 0, 270, 0, 1]];
  const result = supplementDocuments(compiled, resources(), {});

  assert.deepEqual(result.coverage.issues, []);
  assert.deepEqual([...result.files].sort(), [...supplementDocuments(fixture(), resources(), {}).files].sort());
});

test('mapped leaf geometry covers native update and persistence flags without new model requirements', () => {
  const compiled = fixture();

  compiled.blocks[0] = { id: 'minecraft:test_leaves', keys: ['persistent_bit', 'update_bit'], domains: [[false, true], [false, true]], indices: [0, 2], choices: [0, 0] };
  const result = supplementDocuments(compiled, resources(), {});
  const block = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/test_leaves.json');

  assert.ok(block.components?.['minecraft:geometry']);
  assert.equal(block.description.states, undefined);
  assert.equal(block.permutations, undefined);
  assert.equal(result.coverage.generatedBlockStates, 4);
  assert.equal(result.coverage.fallbackBlockStates, 2);
  assert.equal(result.coverage.fallbacks[0].renderedStates, 2);
  assert.deepEqual(result.coverage.gaps, []);
});

test('unmatched native tuples of both slab families use the mapped default and are reported as fallbacks', () => {
  for (const double of [true, false]) {
    const compiled = fixture(), id = 'minecraft:test_' + (double ? 'double_' : '') + 'slab';

    compiled.blocks[0] = { id, keys: ['minecraft:vertical_half'], domains: [['bottom', 'top']], indices: [0], choices: [0] };
    const result = supplementDocuments(compiled, resources(), {});
    const block = blockDefinition(result.files, 'behavior_pack/blocks/' + id.replace(':', '/') + '.json');

    assert.equal(result.coverage.generatedBlockStates, 2);
    assert.equal(result.coverage.fallbackBlockStates, 1);
    assert.ok(block.components?.['minecraft:geometry']);
    assert.equal(block.permutations, undefined);
  }
});

test('sparse mappings use a base model and expose fallback counts without inventing state fields', () => {
  const compiled = fixture();

  compiled.blocks[0].indices = [0];
  compiled.blocks[0].choices = [0];
  const result = supplementDocuments(compiled, resources(), {});

  assert.equal(result.coverage.generatedBlockStates, 2);
  assert.equal(result.coverage.fallbackBlockStates, 1);
  const block = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/test.json');

  assert.ok(block.components?.['minecraft:geometry']);
  assert.equal(block.permutations, undefined);
});

test('canonical sources and weighted shapes render deterministic representatives without ambiguity issues', () => {
  const compiled = fixture();

  compiled.choices[0].push({ ...compiled.choices[0][0], program: 1 });
  const ambiguous = supplementDocuments(compiled, resources(), {});

  assert.equal(ambiguous.coverage.gaps.length, 0);
  assert.equal(ambiguous.coverage.issues.length, 0);
  assert.ok(ambiguous.files.size > 0);
  compiled.choices[0].pop();
  compiled.groups[0].push([0, 90, 0, 0, 3]);
  const weighted = supplementDocuments(compiled, resources(), {});

  assert.deepEqual(weighted.coverage.issues, []);
  assert.match(weighted.coverage.approximations[0].reasons[0], /Weighted model variants/);
  const selected = fixture();

  selected.groups[0] = [[0, 90, 0, 0, 3]];
  assert.deepEqual([...weighted.files], [...supplementDocuments(selected, resources(), {}).files]);
  compiled.groups[0].reverse();
  assert.deepEqual([...supplementDocuments(compiled, resources(), {}).files], [...weighted.files]);
});

test('unmapped IDs, missing source geometry and unsupported conversion remain separate from fallback coverage', () => {
  const compiled = fixture();

  compiled.choices[0] = [];
  const missing = supplementDocuments(compiled, resources(), {});

  assert.equal(missing.coverage.gaps.length, 2);
  assert.deepEqual(missing.coverage.issues, []);
  assert.deepEqual(missing.coverage.gaps[0].states, { axis: 'x' });
  const inverse = fixtureInverse(fixture());

  inverse.blocks[0].rows = [];
  const unknown = supplementDocuments(fixture(), resources(), {}, { inverse });

  assert.equal(unknown.coverage.gaps[0].missingStates, 2);
  assert.equal(unknown.coverage.fallbackBlockStates, 0);
  inverse.blocks[0].rows = [{ values: ['x'], java: 'minecraft:test', properties: {}, sources: 1, failure: { kind: 'unsupported', reason: 'Special renderer required' } }];
  const unsupported = supplementDocuments(fixture(), resources(), {}, { inverse });

  assert.deepEqual(unsupported.coverage.gaps, []);
  assert.equal(unsupported.coverage.issues[0].affectedStates, 2);
  assert.deepEqual(unsupported.coverage.issues[0].stateTuples, [{ axis: 'x' }, { axis: 'y' }]);
  assert.equal(unsupported.coverage.fallbacks[0].affectedStates, 1);
  assert.equal(unsupported.coverage.fallbacks[0].renderedStates, 0);
  assert.equal(unsupported.files.size, 0);
});

test('unavailable exact sources do not silently render a different source from the base components', () => {
  const compiled = fixture(), inverse = fixtureInverse(compiled);

  delete inverse.blocks[0].rows[1].program;
  inverse.blocks[0].rows[1].failure = { kind: 'unsupported', reason: 'Special renderer required' };
  const result = supplementDocuments(compiled, resources(), {}, { inverse });
  const block = blockDefinition(result.files, 'behavior_pack/blocks/minecraft/test.json');

  assert.deepEqual(block.components, {});
  assert.equal(block.permutations?.length, 1);
  const condition = block.permutations?.[0].condition;

  assert.ok(typeof condition === 'string');
  assert.match(condition, /axis.*x/);
  assert.equal(result.coverage.generatedBlockStates, 1);
  assert.equal(result.coverage.issues.length, 1);
});

test('vanilla metadata bounds converted and authored state keys and values', () => {
  const upstream = resources();

  upstream.set('metadata/mojang-blocks.json', { data_items: [{ name: 'minecraft:test', properties: [{ name: 'axis' }] }], block_properties: [{ name: 'axis', values: [{ value: 'x' }, { value: 'y' }] }] });
  assert.equal(supplementDocuments(fixture(), upstream, {}).coverage.generatedBlockStates, 2);
  const invalidKey = fixture();

  invalidKey.blocks[0].keys = ['java_only'];
  assert.throws(() => supplementDocuments(invalidKey, upstream, {}), /State keys differ/);
  const invalidValue = fixture();

  invalidValue.blocks[0].domains[0][0] = 'java_only';
  assert.throws(() => supplementDocuments(invalidValue, upstream, {}), /State values differ/);
  const authored = new Map([['behavior_pack/blocks/minecraft/test.json', { 'minecraft:block': { description: { identifier: 'minecraft:test', states: { java_only: [false, true] } }, components: {} } }]]);

  assert.throws(() => supplementDocuments(fixture(), upstream, {}, { definitions: authored }), /State keys differ/);
});

test('a legacy texture alias does not invent full-cube geometry', () => {
  const upstream = resources();

  upstream.set('blocks.json', { legacy_chain: { textures: 'test' } });
  const result = supplementDocuments({ ...fixture(), blocks: [] }, upstream, { blocks: { 'minecraft:chain': 'minecraft:legacy_chain' } });

  assert.equal(result.files.size, 0);
  assert.match(result.coverage.issues[0].reason, /authored geometry/);
});

test('authored Bedrock definitions fill missing geometry and coexist with automatic components', () => {
  const upstream = resources(), compiled = fixture();

  compiled.textures[0] = 'textures/blocks/absent';
  const file = 'behavior_pack/blocks/minecraft/test.json';
  const authored = { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:test' }, components: {
    'minecraft:geometry': 'minecraft:geometry.full_block', 'minecraft:material_instances': { '*': { texture: 'test', render_method: 'opaque' } },
  } } };
  const fixed = supplementDocuments(compiled, upstream, {}, { definitions: new Map([[file, authored]]) });

  assert.equal(fixed.coverage.gaps.length, 0);
  assert.equal(fixed.coverage.issues.length, 0);
  assert.deepEqual(fixed.coverage.resolvedAuthoredBlocks, ['minecraft:test']);
  const partial = { 'format_version': '1.26.60', 'minecraft:block': { description: { identifier: 'minecraft:test' }, components: { 'minecraft:light_emission': 3 } } };
  const unresolved = supplementDocuments(compiled, upstream, {}, { definitions: new Map([[file, partial]]) });

  assert.equal(unresolved.coverage.gaps.length, 0);
  assert.equal(unresolved.coverage.issues.length, 2);
  const combined = supplementDocuments(fixture(), upstream, {}, { definitions: new Map([[file, partial]]) });

  const components = blockDefinition(combined.files, file).components;

  assert.ok(components?.['minecraft:geometry']);
  assert.equal(components['minecraft:light_emission'], 3);
  upstream.set('blocks/test.json', authored);
  assert.equal(supplementDocuments(fixture(), upstream, {}, { definitions: new Map([[file, authored]]) }).files.size, 0);
  const missingLight = supplementDocuments(fixture(), upstream, {}, { definitions: new Map([[file, partial]]) });
  const audit = auditDocuments({ index: { minecraft: '1.26.60.30' }, lock: {}, documents: missingLight.files }, upstream);

  assert.deepEqual(audit.redundant, []);
  assert.equal(blockDefinition(missingLight.files, file).components?.['minecraft:light_emission'], 3);
});

test('coverage reports canonical block identities without duplicating legacy texture aliases', () => {
  const upstream = resources();

  upstream.set('blocks.json', { legacy: { textures: 'test' } });
  upstream.set('metadata/mojang-blocks.json', { data_items: [{ name: 'minecraft:canonical', serialization_id: 'tile.legacy' }] });
  const report = auditDocuments({ index: { minecraft: '1.26.60.30' }, lock: {}, documents: new Map() }, upstream);

  assert.deepEqual(report.gaps.filter(gap => gap.kind === 'block').map(gap => gap.id), ['minecraft:canonical']);
});
