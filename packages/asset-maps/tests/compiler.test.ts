import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileModels, conditionMatches, resolveJavaModel, selectApplications, type CompileInput } from '../src/compiler/compiler.ts';
import { closedOccluders, compileGeometry, applyBlockRotation } from '../src/compiler/geometry.ts';
import type { JavaModel, Side } from '../src/compiler/types.ts';

const sides: Side[] = ['north', 'south', 'east', 'west', 'up', 'down'];
const cube: JavaModel = { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(sides.map(side => [side, { texture: '#all' }])) }] };
const input = (): CompileInput => ({ source: { java: 'test', bedrock: 'test', mappings: 'test', revision: 'test' }, states: { version: 'test', revision: 'test', blocks: [{ blockId: 'minecraft:test', keys: [], values: [[]] }] }, mappings: { 'minecraft:test': {} }, blockstates: { test: { variants: { '': { model: 'block/test' } } } }, models: { cube, test: { parent: 'block/cube', textures: { all: 'block/test' } } }, texture: path => ({ path, method: 'opaque' }) });

test('resolves Java parents, aliases and checked Bedrock mappings into shared data templates', () => {
  assert.deepEqual(resolveJavaModel('minecraft:block/test', input().models).elements, cube.elements);
  assert.throws(() => resolveJavaModel('a', { a: { parent: 'b' }, b: { parent: 'a' } }), /Cyclic/);
  const result = compileModels(input());

  assert.equal(result.data.geometries.length, 1);
  assert.equal(result.data.geometries[0].faces.length, 6);
  assert.equal(result.coverage.convertedStates, 1);
  assert.deepEqual(result.data.models[0].occluders, [0]);
});

test('keeps multipart predicates, UV locking and weighted choices in generated model programs', () => {
  assert.equal(conditionMatches({ OR: [{ north: 'true' }, { AND: [{ south: 'true' }, { powered: 'true' }] }] }, { north: 'false', south: 'true', powered: 'true' }), true);
  assert.equal(selectApplications({ variants: { '': [{ model: 'a', weight: 1 }, { model: 'b', weight: 3, uvlock: true }] } }, {})[0].length, 2);
  const source = input();

  source.blockstates.test = { variants: { '': [{ model: 'block/test', weight: 1 }, { model: 'block/test', x: 90, uvlock: true, weight: 3 }] } };
  const data = compileModels(source).data;

  assert.deepEqual(data.groups.flat().map(application => application[4]), [1, 3]);
  assert.deepEqual(data.groups.flat()[1].slice(1, 4), [90, 0, 1]);
});

test('targets only supplied Bedrock states and distinguishes missing models from unsupported conversions', () => {
  const source = input();

  source.states.blocks[0] = { blockId: 'minecraft:test', keys: ['native_state'], values: [[0], [1], [2], [3], [4]] };
  source.mappings = {
    'minecraft:test[facing=north]': { state: { native_state: 0 } },
    'minecraft:test[facing=east]': { state: { native_state: 0 } },
    'minecraft:missing': { bedrock_identifier: 'minecraft:test', state: { native_state: 1 } },
    'minecraft:special': { bedrock_identifier: 'minecraft:test', state: { native_state: 2 } },
    'minecraft:test[facing=south]': { state: { native_state: 4 } },
  };
  source.blockstates.test = { variants: { 'facing=north': { model: 'block/test' }, 'facing=east': { model: 'block/test', y: 90 }, 'facing=south': { model: 'block/not_present' } } };
  source.blockstates.special = { variants: { '': { model: 'block/special' } } };
  source.models.special = {};
  const result = compileModels(source);

  assert.deepEqual(result.data.blocks[0].keys, ['native_state']);
  assert.deepEqual(result.data.blocks[0].indices, [0]);
  assert.equal(result.coverage.ambiguousStates, 1);
  assert.equal(result.coverage.unmappedStates, 1);
  assert.equal(result.coverage.missingModelStates, 2);
  assert.equal(result.coverage.unsupportedStates, 1);
  assert.partialDeepStrictEqual(result.coverage.exceptions[0], { total: 5, converted: 1, unmapped: 1, missingModels: 2, unsupported: 1 });
});

test('requires closed opaque visual volumes and handles tilted geometry conservatively', () => {
  const geometry = compileGeometry(cube, () => 0);

  assert.deepEqual(closedOccluders(geometry, () => true), [0]);
  assert.deepEqual(closedOccluders(geometry, () => false), []);
  const open = { elements: [{ ...cube.elements![0], faces: { north: { texture: '#all' } } }] };

  assert.deepEqual(closedOccluders(compileGeometry(open, () => 0), () => true), []);
  const tilted: JavaModel = { elements: [{ ...cube.elements![0], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true } }] };

  assert.deepEqual(compileGeometry(tilted, () => 0).boxes, []);
  const face = { origin: { x: 1, y: 0, z: 0 }, u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, texture: 0, uv: [0, 0, 1, 1] as const };

  assert.equal(Object.values(applyBlockRotation(face, 'north', 90, 90, true).origin).every(Number.isFinite), true);
});
