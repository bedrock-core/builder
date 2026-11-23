import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileModels } from '../src/compiler/compiler.ts';
import type { CompileInput } from '../src/compiler/compiler.ts';
import { buildInverse, createInverseMapper } from '../src/compiler/inverse.ts';
import type { CanonicalInverse, DefaultStates, InverseSources } from '../src/compiler/inverse.ts';

const sources: InverseSources = { schemaVersion: 1, java: 'test', defaults: { sha256: 'test' } };
const fixture = (): CompileInput => ({ source: { java: 'test', bedrock: 'test', mappings: 'test', revision: 'test' },
  states: { version: 'test', revision: 'test', blocks: [{ blockId: 'minecraft:test', keys: ['native_direction'], values: [[0], [1], [2]] }] },
  mappings: {
    'minecraft:test[facing=west,powered=false]': { state: { native_direction: 0 } },
    'minecraft:test[facing=north,powered=false]': { state: { native_direction: 0 } },
    'minecraft:test[facing=south,powered=false]': { state: { native_direction: 0 } },
    'minecraft:test[facing=north,powered=true]': { state: { native_direction: 1 } },
  },
  blockstates: { test: { variants: {
    'facing=north': { model: 'block/test', y: 90 }, 'facing=south': { model: 'block/test', y: 180 }, 'facing=west': { model: 'block/test' },
  } } },
  models: { test: { textures: { all: 'block/test' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all' } } }] } },
  texture: path => ({ path, method: 'opaque' }),
});
const defaults = (): DefaultStates => ({ javaVersion: 'test', blocks: { test: { properties: { facing: ['north', 'south', 'west', 'east'], powered: ['true', 'false'] }, default: 3 } } });
const build = (input = fixture(), metadata = defaults()): CanonicalInverse => buildInverse({ ...input, compiled: compileModels(input).data, defaults: metadata, sources });

test('chooses real Java defaults within an exact native tuple instead of minimum rotation or source insertion order', () => {
  const input = fixture(), compiled = compileModels(input).data;
  const inverse = buildInverse({ ...input, compiled, defaults: defaults(), sources });
  const selected = createInverseMapper(inverse)('minecraft:test', { native_direction: 0 })!;

  assert.equal(selected.kind, 'exact');
  assert.deepEqual(selected.row.properties, { facing: 'south', powered: 'false' });
  assert.equal(compiled.groups[compiled.programs[selected.row.program!][0]][0][2], 180);
  assert.equal(selected.row.sources, 3);
  input.mappings = Object.fromEntries(Object.entries(input.mappings).reverse());
  assert.deepEqual(buildInverse({ ...input, compiled, defaults: defaults(), sources }), inverse);
});

test('uses Java report order for ties and the first forward tuple as the fallback even when another tuple is closer to Java defaults', () => {
  const input = fixture();
  const inverse = build(input), resolve = createInverseMapper(inverse);

  assert.deepEqual(inverse.blocks[0].rows[0].values, [1]);
  assert.deepEqual(resolve('minecraft:test', { native_direction: 2 }), { kind: 'fallback', row: inverse.blocks[0].rows[0] });
  assert.deepEqual(resolve('minecraft:test', { native_direction: 999 })!.row.values, [1]);
  delete input.mappings['minecraft:test[facing=south,powered=false]'];
  assert.equal(createInverseMapper(build(input))('minecraft:test', { native_direction: 0 })!.row.properties.facing, 'north');
});

test('keeps the first Java block ID even when that canonical source cannot convert and a later source can', () => {
  const input = fixture(), metadata = defaults();

  input.mappings['minecraft:alpha'] = { bedrock_identifier: 'minecraft:test', state: { native_direction: 0 } };
  input.blockstates.alpha = { variants: { '': { model: 'block/special' } } };
  input.models.special = {};
  metadata.blocks.alpha = { default: 0 };
  const row = createInverseMapper(build(input, metadata))('minecraft:test', { native_direction: 0 })!.row;

  assert.equal(row.java, 'minecraft:alpha');
  assert.equal(row.program, undefined);
  assert.partialDeepStrictEqual(row.failure, { kind: 'unsupported', reason: 'Java model requires a special renderer: block/special' });
  delete input.models.special;
  assert.equal(createInverseMapper(build(input, metadata))('minecraft:test', { native_direction: 0 })!.row.failure!.kind, 'missing');
});

test('normalizes boolean states, ignores unknown fields and matches omitted fields against the first compatible tuple', () => {
  const inverse = build();

  inverse.blocks[0].keys = ['pressed', 'direction'];
  inverse.blocks[0].domains = [[false, true], [0, 1]];
  inverse.blocks[0].rows = [
    { ...inverse.blocks[0].rows[0], values: [true, 1] },
    { ...inverse.blocks[0].rows[1], values: [false, 0] },
  ];
  const resolve = createInverseMapper(inverse);

  assert.equal(resolve('minecraft:test', { pressed: 1, direction: 1, java_only: 'ignored' })!.kind, 'exact');
  assert.deepEqual(resolve('minecraft:test', { pressed: false })!.row.values, [false, 0]);
  assert.deepEqual(resolve('minecraft:test', { java_only: 'ignored' })!.row.values, [true, 1]);
  assert.equal(resolve('minecraft:test', { pressed: true, direction: 0 })!.kind, 'fallback');
  assert.equal(resolve('minecraft:absent'), undefined);
});

test('rejects mismatched versions, missing defaults and invalid native inventories', () => {
  const input = fixture(), metadata = defaults();

  assert.throws(() => build(input, { ...metadata, javaVersion: 'other' }), /versions/);
  assert.throws(() => build(input, { ...metadata, blocks: {} }), /Missing Java default-state/);
  input.states.blocks[0] = { blockId: 'minecraft:test', keys: ['a', 'b'], values: [[false, false], [true, true]] };
  assert.throws(() => build(input), /complete unique palette/);
});

test('resolves every reached tuple in the native inventory exactly and counts unmatched tuples separately', () => {
  const inverse = build();
  const resolve = createInverseMapper(inverse);
  let reached = 0, fallback = 0, unknown = 0;

  for (const block of inverse.blocks) {
    for (const row of block.rows) {
      const states = Object.fromEntries(block.keys.map((key, i) => [key, row.values[i]]));

      assert.deepEqual(resolve(block.id, states), { kind: 'exact', row });
      reached++;
    }

    const capacity = block.domains.reduce((n, domain) => n * domain.length, 1);

    if (block.rows.length) {
      fallback += capacity - block.rows.length;
    } else {
      unknown += capacity;
      assert.equal(resolve(block.id), undefined);
    }
  }

  assert.equal(reached, 2);
  assert.equal(fallback, 1);
  assert.equal(unknown, 0);
  assert.equal(resolve('minecraft:test', { native_direction: 2 })!.kind, 'fallback');
});
