import type { Release } from '../src/sources/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestRelease, changedDefinitions, updatePlan, newProblems } from '../src/update.ts';
import { geyserReleasePair, matchingGeyserRelease } from '../src/sources/pins.ts';

const release = (version: string, preview = false): Release => {
  const tag = 'v' + version + (preview ? '-preview' : '');
  const name = `bedrock-samples-${tag}-full.zip`;

  return { tag_name: tag, prerelease: preview, assets: [{
    name, browser_download_url: `https://github.com/Mojang/bedrock-samples/releases/download/${tag}/${name}`, digest: 'sha256:' + 'a'.repeat(64),
  }] };
};

test('upstream discovery keeps stable and Preview releases separate and compares numeric versions', () => {
  const values = [release('1.26.60.9', true), release('1.26.60.30', true), release('1.26.50.1'), { ...release('1.26.70.1', true), draft: true }];

  assert.equal(latestRelease(values, 'preview')?.minecraft, '1.26.60.30');
  assert.equal(latestRelease(values, 'stable')?.minecraft, '1.26.50.1');
  assert.throws(() => latestRelease(values, 'latest'), /channel/);
});

test('Preview must have its own full archive while stable hotfixes use their release line', () => {
  const late = release('1.26.70.26', true);
  const values = [
    release('1.26.50.4'),
    release('1.26.60.5'),
    release('1.26.70.24', true),
    { ...late, assets: [] },
  ];

  assert.equal(latestRelease(values, 'preview', '1.26.70.26'), undefined);
  assert.equal(latestRelease([...values, late], 'preview', '1.26.70.26')?.tag, late.tag_name);
  assert.equal(latestRelease(values, 'stable', '1.26.66.1')?.minecraft, '1.26.60.5');
  assert.equal(latestRelease(values, 'stable', '1.26.52.3')?.minecraft, '1.26.50.4');
});
test('source deltas identify additions, removals and changed rendering definitions', () => {
  const before = new Map([['entity/example.json', { 'format_version': '1.8.0', 'minecraft:client_entity': { description: { identifier: 'minecraft:example', textures: { default: 'textures/old' } } } }]]);
  const after = new Map([['entity/example.json', { 'format_version': '1.8.0', 'minecraft:client_entity': { description: { identifier: 'minecraft:example', textures: { default: 'textures/new' } } } }]]);
  const result = changedDefinitions(before, after);

  assert.ok(result.changed.includes('entities/minecraft:example'));
  assert.ok(result.added.includes('textures/textures/new'));
  assert.ok(result.removed.includes('textures/textures/old'));
});
test('automation proposes deterministic updates and requires matching state inputs before advancing versions', () => {
  const input = { current: '1.26.60.30', candidate: '1.26.60.40', conversionVersion: '1.26.60.30', audit: { errors: [], gaps: [] } };

  assert.deepEqual(updatePlan(input), { changed: true, regenerate: false, issue: true, reasons: ['Matching Bedrock state and model conversion inputs are required before advancing the source pin.'] });
  const ready = updatePlan({ ...input, conversionVersion: input.candidate });

  assert.equal(ready.regenerate, true);
  assert.equal(ready.issue, false);
  assert.equal(updatePlan({ ...input, candidate: input.current, sourceChanged: true }).regenerate, true);
  assert.equal(updatePlan({ ...input, conversionVersion: input.candidate, audit: { errors: [{ kind: 'block', id: 'missing', reason: 'Missing model' }], gaps: [] } }).regenerate, false);
  assert.equal(updatePlan({ ...input, conversionVersion: input.candidate, requirements: ['Review the Java renderer profile.'] }).regenerate, false);
});

test('mapping discovery selects an exact declared edition pair and a numeric release revision', () => {
  const mapping = (version: string, bedrock = '1.26.60', java = '26.3'): Release => ({ tag_name: version, body: `These mappings were generated for Minecraft: Java Edition ${java} and Minecraft: Bedrock Edition ${bedrock}.`,
    assets: [{ name: 'mappings-full.zip', browser_download_url: `https://github.com/GeyserMC/mappings-generator/releases/download/${version}/mappings-full.zip`, digest: 'sha256:' + 'a'.repeat(64) }] });
  const values = [mapping('2.1.1-build.2'), mapping('2.1.1-build.10'), mapping('3.0.0', '1.26.70')];

  assert.equal(matchingGeyserRelease(values, '1.26.60', '26.3')?.version, '2.1.1-build.10');
  assert.equal(matchingGeyserRelease(values, '1.26.60', '26.4'), undefined);
  assert.equal(geyserReleasePair({ ...mapping('2.1.1'), draft: true }), undefined);
  assert.equal(geyserReleasePair({ ...mapping('2.1.1'), assets: [{ name: 'mappings-full.zip', browser_download_url: 'https://example.com/source.zip', digest: '' }] }), undefined);
});

test('coverage discovery reports new problems without repeating accepted omissions or duplicate states', () => {
  const old = { kind: 'block', id: 'minecraft:education', reason: 'Missing source' }, added = { kind: 'texture', id: 'minecraft:new', reason: 'Missing binding' };

  assert.deepEqual(newProblems([old], [old, added, added]), [added]);
});

test('coverage compares exact states and relationships, including equal-sized changes to existing gaps', () => {
  const old = { kind: 'block', id: 'minecraft:button', reason: 'Missing model' };
  const state = { facing_direction: 1, button_pressed_bit: false };
  const newState = { ...state, facing_direction: 2 };
  const before = [{ ...old, stateTuples: [state, { ...state, facing_direction: 0 }], affectedStates: 2 }];
  const after = [{ ...old, stateTuples: [{ button_pressed_bit: false, facing_direction: 1 }, newState], affectedStates: 2 }];

  assert.deepEqual(newProblems(before, after), [{ ...old, states: newState }]);
  assert.deepEqual(newProblems([{ ...old, file: 'first' }], [{ ...old, file: 'second' }]), [{ ...old, file: 'second' }]);
  assert.deepEqual(newProblems([{ ...old, missingStates: 2 }], [{ ...old, missingStates: 3 }]), [{ ...old, missingStates: 3 }]);
});
