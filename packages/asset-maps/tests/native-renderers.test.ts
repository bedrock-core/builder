import type { Components, Definition, Geometry, NativeFace } from '../src/bedrock/types.ts';
import type { BlockStates, CompiledModelSource, ModelSources } from '../src/compiler/types.ts';
import type { InverseBlock } from '../src/compiler/inverse.ts';
import type { TextureBindings } from '../src/compiler/textures.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryFaces } from '../src/bedrock/geometry.ts';
import { nativeAssets } from '../src/bedrock/native.ts';
import { supplementDocuments } from '../src/bedrock/documents.ts';
import { clipNativeFace } from '../src/bedrock/native-renderers.ts';
import { nativeResources } from '../src/sources/pack.ts';

const resources = new Map([...(await nativeResources({ offline: true }))].filter(([file]) => /^(models|entity|textures)\//.test(file)));
const native = nativeAssets(resources);
const source: ModelSources = { bedrock: '1.26.60.30', java: '26.3', mappings: 'fixture', revision: 'fixture' };
const textures: TextureBindings = {
  schemaVersion: 1, source, native: { schemaVersion: 1, minecraft: source.bedrock, archive: { url: 'https://example.test/assets.zip', sha256: '0'.repeat(64) } },
  paths: [], models: {}, statistics: { faces: 0, resolved: 0, unresolved: 0, methods: {} },
  images: Object.fromEntries(Object.values(native.entities).flatMap(entity => Object.values(entity['minecraft:client_entity'].description.textures ?? {})).map(path => [
    path, { width: 1, height: 1, frame: [0, 0, 1, 1], method: 'cutout' },
  ])),
};
const skulls = ['player_head', 'skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'creeper_head', 'dragon_head', 'piglin_head'];
const colours = ['undyed', 'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const blocks: InverseBlock[] = [
  { id: 'minecraft:bed', keys: ['direction', 'head_piece_bit', 'occupied_bit'], domains: [[0, 1, 2, 3], [false, true], [false, true]], rows: [] },
  ...skulls.map(name => ({ id: 'minecraft:' + name, keys: ['facing_direction'], domains: [[0, 1, 2, 3, 4, 5]], rows: [] })),
  ...colours.map(colour => ({ id: 'minecraft:' + colour + '_shulker_box', keys: [], domains: [], rows: [] })),
];
const compiled: CompiledModelSource = {
  schemaVersion: 1, source, provider: 'native-fixture',
  blocks: [], textures: [], materials: [], geometries: [], models: [], groups: [], programs: [], choices: [],
};
const result = supplementDocuments(compiled, resources, {}, {
  inverse: { schemaVersion: 1, source, nativeRevision: 'fixture', defaults: { sha256: '0'.repeat(64) }, blocks },
  textures,
});

function block(name: string): Definition {
  const definition = result.files.get('behavior_pack/blocks/minecraft/' + name + '.json')?.['minecraft:block'];

  assert.ok(definition, name);

  return definition;
}

function components(name: string, states: BlockStates): Components {
  const document = block(name);
  const permutation = document.permutations?.find(({ condition }) => typeof condition === 'string'
    && Object.entries(states).every(([key, state]) => condition.includes(`q.block_state('${key}') == ${typeof state === 'boolean' ? Number(state) : state}`)));
  const selected = permutation?.components ?? document.components;

  assert.ok(selected, name);

  return selected;
}

const geometry = (name: string): Geometry | undefined => [...result.files.values()].flatMap(value => value['minecraft:geometry'] ?? []).find(value => value.description.identifier === name);

const faces = (components: Components): NativeFace[] => {
  const reference = components['minecraft:geometry'];

  assert.ok(reference);
  const id = typeof reference === 'string' ? reference : reference.identifier;
  const value = geometry(id) ?? native.models[id]?.geometry;

  assert.ok(value, id);
  const visibility = typeof reference === 'string' ? {} : reference.bone_visibility ?? {};

  return geometryFaces(value).filter(face => visibility[face.bone] !== false);
};

const points = (faces: NativeFace[]): number[][] => faces.flatMap(face => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => (['x', 'y', 'z'] as const).map(axis => face.origin[axis] + face.u[axis] * u + face.v[axis] * v)));
const bounds = (faces: NativeFace[]): number[] => [Math.min, Math.max].flatMap(operation => [0, 1, 2].map(axis => operation(...points(faces).map(p => p[axis]))));
const close = (actual: readonly number[], expected: readonly number[]): void => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5, `${i}: ${value} != ${expected[i]}`));

const path = (components: Components): string => {
  const alias = components['minecraft:material_instances']?.['*'].texture;

  assert.ok(alias);
  const texture = native.textures[alias]?.paths[0] ?? result.files.get('resource_pack/textures/terrain_texture.json')?.texture_data?.[alias].textures;

  assert.ok(typeof texture === 'string', alias);

  return texture;
};

test('native geometry covers every Bedrock tuple without Java models, mappings or renderer input', () => {
  assert.equal(result.coverage.generatedBlockStates, 16 + 7 * 6 + 17);
  assert.equal(result.coverage.fallbackBlockStates, 0);
  assert.deepEqual(result.coverage.gaps, []);
  assert.deepEqual(result.coverage.issues, []);
  assert.equal(result.coverage.approximations.some(entry => entry.reasons.some(reason => /from Java/.test(reason))), false);
  assert.deepEqual(Object.keys(block('bed').description.states ?? {}), ['direction', 'head_piece_bit']);

  for (const name of skulls) {
    assert.deepEqual(Object.keys(block(name).description.states ?? {}), ['facing_direction']);
  }
});

test('shulker blocks reuse the native mesh, exclude the mob head and resolve every native colour alias', () => {
  const { geometry, textures } = native.entities['minecraft:shulker']['minecraft:client_entity'].description;

  assert.ok(geometry && textures);

  for (const colour of colours) {
    const selected = components(colour + '_shulker_box', {});

    assert.deepEqual(selected['minecraft:geometry'], { identifier: geometry.default, bone_visibility: { head: false } });
    assert.equal(path(selected), textures[colour === 'light_gray' ? 'silver' : colour]);
    const actual = faces(selected);

    assert.equal(actual.length, 12);
    assert.equal(actual.some(face => face.bone === 'head'), false);
    close(bounds(actual), [-8, 0, -8, 8, 16, 8]);
  }
});

test('bed halves retain the native top UVs, leg positions and shared texture at all four directions', () => {
  for (let direction = 0; direction < 4; direction++) {
    const halves = [false, true].map(head_piece_bit => components('bed', { direction, head_piece_bit }));

    for (const half of halves) {
      assert.equal(path(half), native.entities['minecraft:bed']['minecraft:client_entity'].description.textures?.default);
      close(bounds(faces(half)), [-8, 0, -8, 8, 9, 8]);
    }

    assert.notEqual(halves[0]['minecraft:geometry'], halves[1]['minecraft:geometry']);
  }

  for (const [head_piece_bit, topY] of [[false, 22], [true, 6]] as const) {
    const actual = faces(components('bed', { direction: 2, head_piece_bit }));
    const top = actual.find(face => Math.abs(face.origin.y - 9) < 1e-5 && Math.hypot(face.u.x, face.u.z) > 15.9 && Math.hypot(face.v.x, face.v.z) > 15.9);

    assert.ok(top);
    close(top.uv, [6 / 64, topY / 64, 16 / 64, 16 / 64]);
    assert.equal(new Set(actual.map(face => face.bone)).size, 3);
  }
});

test('native skull sheets keep their UV axes and wall placement, with only the piglin head subtree', () => {
  const skull = native.entities['minecraft:skull']['minecraft:client_entity'].description;
  const aliases = ['steve', 'skeleton', 'wither', 'zombie', 'creeper', 'dragon', 'piglin'];

  for (const [index, name] of skulls.entries()) {
    for (let facing_direction = 0; facing_direction < 6; facing_direction++) {
      const selected = components(name, { facing_direction });

      assert.equal(path(selected), skull.textures?.[aliases[index]]);
      const actual = faces(selected);

      assert.ok(actual.length >= 6);
      assert.equal(actual.some(face => /body|arm|leg|Item/.test(face.bone)), false);
    }
  }

  const floor = faces(components('skeleton_skull', { facing_direction: 1 }));

  close(bounds(floor), [-4, 0, -4, 4, 8, 4]);
  const front = floor.find(face => Math.abs(face.origin.z + 4) < 1e-5 && Math.abs(face.u.x - 8) < 1e-5);

  assert.ok(front);
  close(front.uv, [8 / 64, 8 / 32, 8 / 64, 8 / 32]);
  assert.ok(front.v.y < 0);
  const piglinId = components('piglin_head', { facing_direction: 1 })['minecraft:geometry'];

  assert.ok(typeof piglinId === 'string');
  const piglin = geometry(piglinId);

  assert.equal(piglin?.bones.find(bone => bone.name === 'leftear')?.parent, 'head');
  assert.equal(piglin?.bones.find(bone => bone.name === 'rightear')?.parent, 'head');

  for (const [facing_direction, expected] of [[2, [-4, 4, -8, 4, 12, 0]], [3, [-4, 4, 0, 4, 12, 8]], [4, [0, 4, -4, 8, 12, 4]], [5, [-8, 4, -4, 0, 12, 4]]] as const) {
    close(bounds(faces(components('skeleton_skull', { facing_direction }))), expected);
  }
});

test('bed clipping preserves UV direction for both signs and drops empty slices', () => {
  for (const sign of [-1, 1]) {
    const face: NativeFace = { bone: 'root', origin: { x: 0, y: sign < 0 ? 32 : 0, z: 0 }, u: { x: 16, y: 0, z: 0 }, v: { x: 0, y: sign * 32, z: 0 }, uv: [0, 0, 1, 1] };
    const clipped = clipNativeFace(face, 0, 16);

    assert.ok(clipped);
    close(clipped.uv, [0, sign < 0 ? 0.5 : 0, 1, 0.5]);
    assert.equal(clipNativeFace(face, 40, 48), undefined);
  }
});
