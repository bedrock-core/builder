import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStateCapture } from '../src/bedrock/states.ts';

const base = { version: '1.26.60.30', revision: 'old', blocks: [] };
const metadata = { data_items: [{ name: 'minecraft:repeater', properties: [{ name: 'minecraft:cardinal_direction' }, { name: 'locked' }] }], block_properties: [
  { name: 'minecraft:cardinal_direction', values: [{ value: 'south' }, { value: 'north' }] }, { name: 'locked', values: [{ value: false }, { value: true }] },
] };

test('state capture keeps actual tuples, removes deprecated aliases and does not invent absent native properties', () => {
  const blocks = [{ blockId: 'minecraft:repeater', keys: ['direction', 'minecraft:cardinal_direction'], values: [[0, 'south'], [0, 'south'], [2, 'north']] }, { blockId: 'minecraft:future', keys: [], values: [], error: 'Not registered' }];
  const merged = mergeStateCapture(base, { version: base.version, blocks }, metadata);

  assert.deepEqual(merged.blocks, [{ blockId: 'minecraft:repeater', keys: ['minecraft:cardinal_direction'], values: [['south'], ['north']] }]);
  assert.match(merged.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(base.blocks, []);
  assert.deepEqual(mergeStateCapture(merged, { version: base.version, blocks }, metadata), merged);
});

test('state capture refuses a different release, unknown identifiers and invalid native values', () => {
  assert.throws(() => mergeStateCapture(base, { version: '1.26.50.1', blocks: [] }, metadata), /same Bedrock/);
  assert.throws(() => mergeStateCapture(base, { version: base.version, blocks: [{ blockId: 'minecraft:unknown', keys: [], values: [[]] }] }, metadata), /absent/);
  assert.throws(() => mergeStateCapture(base, { version: base.version, blocks: [{ blockId: 'minecraft:repeater', keys: ['minecraft:cardinal_direction'], values: [['wrong']] }] }, metadata), /domain/);
});
