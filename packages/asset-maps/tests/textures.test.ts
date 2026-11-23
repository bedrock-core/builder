import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTextureBindings, createTextureResolver, inferredTextureCandidates, pixelHash, remapFaceTexture, textureCandidates } from '../src/compiler/textures.ts';
import { compileModels, type CompileInput } from '../src/compiler/compiler.ts';
import type { FaceTexture, NativeImage } from '../src/compiler/textures.ts';
import type { ImagePixels } from '../src/sources/formats.ts';

const image = (width: number, height: number, values: number[]): ImagePixels => ({ width, height, rgba: Uint8Array.from(values.flatMap(value => [value, value * 2 % 256, value * 3 % 256, 255])) });
const native = (value: ImagePixels): NativeImage => ({ ...value, frame: [0, 0, value.width, value.height], method: 'opaque' });

test('learns repeated naming substitutions without accepting isolated or ambiguous guesses', () => {
  const mappings = { block: { activator_rail_on: 'rail_activator_powered', detector_rail_on: 'rail_detector_powered', light_gray_wool: 'wool_colored_silver', light_gray_carpet: 'carpet_silver' } };
  const infer = inferredTextureCandidates(mappings, ['textures/blocks/lightning_rod_powered', 'textures/entity/shulker/shulker_silver']);

  assert.deepEqual(infer('block/lightning_rod_on'), ['textures/blocks/lightning_rod_powered']);
  assert.deepEqual(infer('entity/shulker/shulker_light_gray'), []);
  const single = inferredTextureCandidates({ block: { activator_rail_on: 'rail_activator_powered' } }, ['textures/blocks/lightning_rod_powered']);

  assert.deepEqual(single('block/lightning_rod_on'), []);
  const atlas = image(1, 1, [9]);
  const resolve = createTextureResolver({ mappings, images: new Map([['textures/blocks/lightning_rod_powered', native(atlas)]]), atlas, rectangles: { 'block/lightning_rod_on': [0, 0, 1, 1] } });

  assert.partialDeepStrictEqual(resolve('block/lightning_rod_on', [0, 0, 1, 1]), { path: 'textures/blocks/lightning_rod_powered', resolution: 'naming' });
});

test('uses mapping alternatives and preserves nested group paths', () => {
  const mappings = { 'block': { source: ['missing', 'nested/present'] }, 'block/lever': 'blocks/lever' };

  assert.deepEqual(textureCandidates('minecraft:block/source', mappings).map(value => value.path), ['textures/blocks/missing', 'textures/blocks/nested/present', 'textures/blocks/source']);
  assert.equal(textureCandidates('block/lever', mappings)[0].path, 'textures/blocks/lever');
  const atlas = image(2, 2, [1, 2, 3, 4]);
  const resolve = createTextureResolver({ mappings, images: new Map([['textures/blocks/nested/present', native(atlas)]]), atlas, rectangles: { 'block/source': [0, 0, 2, 2] } });

  assert.partialDeepStrictEqual(resolve('block/source', [0, 0, 1, 1]), { path: 'textures/blocks/nested/present', resolution: 'mapping' });
});

test('matches renamed sprites by exact visible pixels and refuses ambiguous native paths', () => {
  const atlas = image(2, 2, [1, 2, 3, 4]);
  const images = new Map([['textures/blocks/renamed', native(atlas)]]);
  const input = { mappings: {}, images, atlas, rectangles: { 'block/source': [0, 0, 2, 2] } };

  assert.partialDeepStrictEqual(createTextureResolver(input)('block/source', [0, 0, 1, 1]), { path: 'textures/blocks/renamed', resolution: 'pixels' });
  images.set('textures/blocks/another_name', native(atlas));
  assert.partialDeepStrictEqual(createTextureResolver(input)('block/source', [0, 0, 1, 1]), { error: 'Native pixel match is ambiguous' });
});

test('derives rotated native sheet UVs from pixel regions while preserving quad corners and winding', () => {
  const atlas = image(2, 3, [11, 22, 33, 44, 55, 66]);
  const target = native(image(5, 4, [99, 99, 99, 99, 99, 99, 55, 33, 11, 99, 99, 66, 44, 22, 99, 99, 99, 99, 99, 99]));
  const resolve = createTextureResolver({ mappings: {}, images: new Map([['textures/entity/sample_banner', target]]), atlas, rectangles: { 'block/banner_sample': [0, 0, 2, 3] } });
  const binding = resolve('block/banner_sample', [0, 0, 1, 1]);

  assert.equal(binding.resolution, 'pixel-region');
  const [x, y, a, b, c, d] = binding.transform!;

  for (let v = 0; v < 3; v++) {
    for (let u = 0; u < 2; u++) {
      const tx = Math.floor((x + a * (u + 0.5) / 2 + b * (v + 0.5) / 3) * target.width);
      const ty = Math.floor((y + c * (u + 0.5) / 2 + d * (v + 0.5) / 3) * target.height);

      assert.equal(target.rgba[(ty * target.width + tx) * 4], atlas.rgba[(v * 2 + u) * 4]);
    }
  }

  const mapped = remapFaceTexture([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1, 0], binding);

  assert.deepEqual(mapped.slice(0, 9).map(value => value || 0), [0, 1, 0, 0, -1, 0, 1, 0, 0]);
  assert.ok(Math.abs(mapped[9] - (0.2)) < 0.5 * 10 ** -2);
  assert.ok(Math.abs(mapped[10] - (0.25)) < 0.5 * 10 ** -2);
  assert.ok(Math.abs(mapped[11] - (0.6)) < 0.5 * 10 ** -2);
  assert.ok(Math.abs(mapped[12] - (0.5)) < 0.5 * 10 ** -2);
  assert.throws(() => remapFaceTexture([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 1, 1], binding), /outside the verified/);
});

test('keeps logical block UVs when the native alias uses a flipbook sheet', () => {
  const atlas = image(2, 4, [1, 2, 3, 4, 5, 6, 7, 8]);
  const value: NativeImage = { ...native(atlas), frame: [0, 2, 2, 2] };
  const resolve = createTextureResolver({ mappings: {}, images: new Map([['textures/blocks/animated', value]]), atlas, rectangles: { 'block/animated': [0, 0, 2, 4] } });

  assert.deepEqual(resolve('block/animated', [0, 0, 1, 1]).transform, [0, 0, 1, 0, 0, 1]);
});

test('ignores RGB under fully transparent pixels when matching but preserves visible color differences', () => {
  const a = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 0]) };
  const b = { width: 1, height: 1, rgba: new Uint8Array([0, 255, 0, 0]) };

  assert.equal(pixelHash(a, [0, 0, 1, 1]), pixelHash(b, [0, 0, 1, 1]));
  a.rgba[3] = b.rgba[3] = 128;
  assert.notEqual(pixelHash(a, [0, 0, 1, 1]), pixelHash(b, [0, 0, 1, 1]));
});

function layoutFixture(offsets: (number | null)[], { targetParent = 'template', targetWidth = 4 } = {}): FaceTexture {
  const source: CompileInput = { source: { java: 'test', bedrock: 'test', mappings: 'test', revision: 'test' }, states: { version: 'test', revision: 'test', blocks: [] }, mappings: {}, blockstates: {},
    models: { template: { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all' } } }] } }, texture: path => ({ path, method: 'opaque' }) };
  const rectangles: Record<string, number[]> = {}, images = new Map<string, NativeImage>(), mappings: Record<string, string> = {};
  const patterns = offsets.map((_, index) => [11, 22, 33, 44].map(value => value + index * 45));

  source.models.other = structuredClone(source.models.template);

  for (const [i, x] of offsets.entries()) {
    const name = 'material' + i, symbol = 'block/' + name, path = 'textures/blocks/native' + i;
    const width = i === offsets.length - 1 ? targetWidth : 4;
    const pixels = Array<number>(width * 2).fill(250);

    if (x !== null) {
      pixels[x] = patterns[i][0];
      pixels[x + 1] = patterns[i][1];
      pixels[width + x] = patterns[i][2];
      pixels[width + x + 1] = patterns[i][3];
    }

    images.set(path, native(image(width, 2, pixels)));
    mappings[symbol] = path;
    rectangles[symbol] = [i * 2, 0, 2, 2];
    source.models[name] = { parent: 'block/' + (i === offsets.length - 1 ? targetParent : 'template'), textures: { all: symbol } };
    source.blockstates[name] = { variants: { '': { model: 'block/' + name } } };
    source.mappings['minecraft:' + name] = {};
    source.states.blocks.push({ blockId: 'minecraft:' + name, keys: [], values: [[]] });
  }

  const atlas = image(offsets.length * 2, 2, [...patterns.flatMap(values => values.slice(0, 2)), ...patterns.flatMap(values => values.slice(2))]);
  const result = buildTextureBindings({ compiled: compileModels(source).data, models: source.models, mappings, images, atlas, rectangles, native: { schemaVersion: 1, minecraft: 'test', archive: { url: 'https://example.test/native', sha256: 'test' } } });

  const name = Object.keys(result.models).find(name => name.endsWith('/material' + (offsets.length - 1)));

  return result.models[name!][0];
}

test('learns shared UV templates from two independent pixel witnesses or a unique leading consensus', () => {
  assert.partialDeepStrictEqual(layoutFixture([1, 1, null]), { resolution: 'layout', transform: [0.25, 0, 0.5, 0, 0, 1] });
  assert.partialDeepStrictEqual(layoutFixture([1, 1, 1, 0, null]), { resolution: 'layout', transform: [0.25, 0, 0.5, 0, 0, 1] });
});

test('leaves UV templates unresolved with one witness, tied layouts or mismatched templates and dimensions', () => {
  assert.equal(layoutFixture([1, null]).path, undefined);
  assert.equal(layoutFixture([0, 0, 2, 2, null]).path, undefined);
  assert.equal(layoutFixture([1, 1, null], { targetParent: 'other' }).path, undefined);
  assert.equal(layoutFixture([1, 1, null], { targetWidth: 6 }).path, undefined);
});
