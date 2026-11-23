import type { NativeFace } from '../src/bedrock/types.ts';
import type { EntityBoneFaces, ExtractedEntityModel } from '../src/compiler/entity.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { geometryFaces } from '../src/bedrock/geometry.ts';
import { faceCube } from '../src/bedrock/documents.ts';
import { javaResources, javaRuntime } from '../src/sources/java.ts';
import { buildRendererInputs } from '../src/sources/renderer-input.ts';
import { fileURLToPath } from 'node:url';
import { entityModelFaces } from '../src/compiler/entity.ts';
import { lockedInput } from '../src/sources/download.ts';

const pins = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url), 'utf8'));
const profile = JSON.parse(await readFile(new URL('../data/renderer-profiles.json', import.meta.url), 'utf8'));

const cache = fileURLToPath(new URL('../.bedrock-core/cache/asset-maps/inputs', import.meta.url));
const client = await lockedInput(pins.java.client, cache, { offline: true, extension: '.jar', maxBytes: 128 * 1024 * 1024 });
const inputs = buildRendererInputs({ java: pins.java, runtime: await javaRuntime(pins.java, cache, { offline: true }), resources: javaResources(client), profile,
  names: { mappings: {}, resolve: () => 'textures/sheet' }, minecraft: pins.bedrock.minecraft });

const packedBounds = (bones: EntityBoneFaces[]): number[] => {
  const points = bones.flatMap(bone => bone.faces.flatMap(face => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => face.slice(0, 3).map((n, i) => n + u * face[3 + i] + v * face[6 + i]))));

  return [0, 1, 2].map(i => Math.min(...points.map(p => p[i])) * 16).concat([0, 1, 2].map(i => Math.max(...points.map(p => p[i])) * 16));
};

const close = (actual: readonly number[], expected: readonly number[]): void => actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-5, `${i}: ${n} != ${expected[i]}`));
const corners = (faces: NativeFace[]): string[] => faces.map(face => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [
  ...(['x', 'y', 'z'] as const).map(axis => face.origin[axis] + u * face.u[axis] + v * face.v[axis]), face.uv[0] + u * face.uv[2], face.uv[1] + v * face.uv[3],
].map(n => Math.round(n * 1e6) / 1e6).join(',')).sort().join(';')).sort();

test('entity box UVs round-trip to native cube UVs including inflation and mirrored faces', () => {
  for (const mirror of [false, true]) {
    for (const grow of [0, 0.25]) {
      const model: ExtractedEntityModel = { id: 'minecraft:fixture', transform: [], layers: { main: { texture: [64, 64], root: { children: {}, pose: { offset: [0, 0, 0], rotation: [0, 0, 0] }, cubes: [{ origin: [1, 0, 1], size: [14, 10, 14], uv: [0, 19], mirror, grow: [grow, grow, grow] }] } } } };
      const bones = entityModelFaces(model, 'main').map(bone => ({ name: bone.name, cubes: bone.faces.map(face => faceCube(face, '*')) }));
      const actual = geometryFaces({ description: { identifier: 'geometry.actual', texture_width: 16, texture_height: 16 }, bones });
      const expected = geometryFaces({ description: { identifier: 'geometry.expected', texture_width: 64, texture_height: 64 }, bones: [{ name: 'root', cubes: [{ origin: [-7, 0, -7], size: [14, 10, 14], uv: [0, 19], mirror, inflate: grow }] }] });

      assert.deepEqual(corners(actual), corners(expected));
    }
  }
});

test('real chest rest poses include the lid and latch and rotate around the native block centre', () => {
  const model = inputs.models['minecraft:chest'];
  const rest = entityModelFaces(model, 'main');

  assert.ok(rest.some(bone => bone.name.endsWith('_lid')));
  assert.ok(rest.some(bone => bone.name.endsWith('_lock')));
  close(packedBounds(rest), [1, 0, 1, 15, 14, 16]);
  close(packedBounds(entityModelFaces(model, 'main', { rotation: 90 })), [1, 0, 1, 16, 14, 15]);
});

test('decorated pot sides retain the extracted single-face mask instead of duplicating coplanar faces', () => {
  const model = inputs.models['minecraft:decorated_pot_sides'];
  const bones = entityModelFaces(model, 'main').filter(bone => bone.faces.length);

  assert.equal(bones.length, 4);
  assert.ok(bones.every(bone => bone.faces.length === 1 && bone.faces[0][16] === 0));
  const unsupported = structuredClone(model);

  Object.values(unsupported.layers.main.root.children)[0].cubes[0].uvScale = [0.5, 1];
  assert.throws(() => entityModelFaces(unsupported, 'main'), /Unsupported entity cube UV scale/);
});

test('all sixteen banner rotations retain orthogonal faces without rounding thin geometry away', () => {
  for (let rotation = 0; rotation < 360; rotation += 22.5) {
    for (const layer of ['main', 'flag']) {
      const bones = entityModelFaces(inputs.models['minecraft:standing_banner'], layer, { rotation });

      assert.ok(bones.some(bone => bone.faces.length));

      for (const bone of bones) {
        for (const face of bone.faces) {
          assert.ok(face.every(Number.isFinite));
          assert.doesNotThrow(() => faceCube(face, '*'));
        }
      }
    }
  }
});
