import type { ImagePixels } from '../src/sources/formats.ts';
import type { JavaSource, Sources } from '../src/sources/types.ts';
import type { Coverage } from '../src/bedrock/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { encodePng, javaAtlas, javaResources, validateJavaManifest } from '../src/sources/java.ts';
import { assertCoverageParity, validateSources } from '../src/pipeline.ts';
import { bedrockResources } from '../src/sources/pack.ts';
import { buildTextureNames } from '../src/sources/texture-names.ts';
import { update } from '../src/update.ts';
import { pngPixels } from '../src/sources/formats.ts';
import { lockedInput } from '../src/sources/download.ts';

const hash = (bytes: Uint8Array, algorithm = 'sha256'): string => createHash(algorithm).update(bytes).digest('hex');
const image = (width: number, height: number, value: number): ImagePixels => ({ width, height, rgba: Buffer.from(Array.from({ length: width * height }, (_, i) => [value + i, i, value, 255]).flat()) });

type ZipEntries = [name: string, content: unknown][];

function zip(files: ZipEntries): Buffer {
  const locals = [], central = [];
  let offset = 0;

  for (const [name, value] of files) {
    const path = Buffer.from(name), content = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), payload = deflateRawSync(content);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);

    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(path.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, path, payload);
    central.push(entry, path);
    offset += local.length + path.length + payload.length;
  }

  const directory = Buffer.concat(central), end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

test('own Java atlas reads declared sources and packs full animation sheets deterministically', () => {
  const a = image(2, 4, 10), b = image(3, 2, 40), ignored = image(1, 1, 80);
  const files: ZipEntries = [['assets/minecraft/atlases/blocks.json', { sources: [{ type: 'minecraft:directory', source: 'block', prefix: 'block/' }, { type: 'minecraft:single', resource: 'entity/b', sprite: 'block/b' }] }],
    ['assets/minecraft/textures/block/a.png', encodePng(a)], ['assets/minecraft/textures/entity/b.png', encodePng(b)], ['assets/minecraft/textures/item/ignored.png', encodePng(ignored)],
    ['assets/minecraft/models/block/test.json', { parent: 'block/cube' }], ['assets/minecraft/blockstates/test.json', { variants: {} }]];
  const resources = javaResources(zip(files)), atlas = javaAtlas(resources.sprites);

  assert.deepEqual([...resources.sprites.keys()].sort(), ['block/a', 'block/b']);
  assert.deepEqual(resources.models.test, { parent: 'block/cube' });
  assert.deepEqual(resources.blockstates.test, { variants: {} });
  assert.equal(atlas.rectangles['block/a'][3], 4);
  assert.deepEqual(atlas.png, javaAtlas(new Map([...resources.sprites].reverse())).png);
  const decoded = pngPixels(atlas.png);

  for (const [id, original] of resources.sprites) {
    const [x, y] = atlas.rectangles[id];

    for (let row = 0; row < original.height; row++) {
      assert.deepEqual([...decoded.rgba.subarray(((y + row) * decoded.width + x) * 4, ((y + row) * decoded.width + x + original.width) * 4)], [...original.rgba.subarray(row * original.width * 4, (row + 1) * original.width * 4)]);
    }
  }

  const sprite = resources.image('entity/b');

  assert.ok(sprite);
  assert.deepEqual([...sprite.rgba], [...b.rgba]);
  assert.throws(() => javaResources(zip([['assets/minecraft/atlases/blocks.json', { sources: [{ type: 'minecraft:future' }] }]])), /Unsupported Java block atlas source/);
  assert.throws(() => javaResources(zip([['assets/minecraft/atlases/blocks.json', { sources: [{ type: 'minecraft:single', resource: '../escape' }] }]])), /Unsupported Java sprite resource/);
});

test('native extraction combines official RP, render BP and identifier metadata while excluding scripts', () => {
  const required: ZipEntries = [['metadata/vanilladata_modules/mojang-blocks.json', { data_items: [] }], ['metadata/vanilladata_modules/mojang-items.json', { data_items: [] }]];
  const resources = bedrockResources(zip([...required, ['resource_pack/entity/allay.json', { format_version: '1.10.0' }], ['behavior_pack/blocks/block.json', { 'minecraft:block': {} }], ['behavior_pack/scripts/ignored.js', 'ignored']]));

  assert.equal(resources.size, 4);
  assert.ok(resources.has('entity/allay.json') && resources.has('blocks/block.json'));
  assert.throws(() => bedrockResources(zip([...required, ['resource_pack/models/../escape.json', {}]])), /Invalid or duplicate native/);
  assert.throws(() => bedrockResources(zip([required[0]])), /missing native identifier metadata/);
});

test('source validation rejects mixed edition pairs and unpinned inputs', async () => {
  const source: Sources = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url), 'utf8'));

  assert.equal(validateSources(source), source);
  const mixed = structuredClone(source);

  mixed.mappings.java = 'other';
  assert.throws(() => validateSources(mixed), /version pair/);
  const unpinned = structuredClone(source);

  Reflect.deleteProperty(unpinned.java.libraries[0], 'sha256');
  assert.throws(() => validateSources(unpinned), /SHA-256/);
  const mislabeled = structuredClone(source);

  mislabeled.bedrock.channel = 'stable';
  assert.throws(() => validateSources(mislabeled), /source families/);
});

test('official manifest validation rejects omitted libraries and altered client coordinates', () => {
  const artifact = { url: 'https://example.test/client.jar', sha1: 'a'.repeat(40), size: 4 };
  const library = { name: 'test:library:1', downloads: { artifact: { ...artifact, url: 'https://example.test/library.jar' } } };
  const bytes = Buffer.from(JSON.stringify({ id: '26.3', javaVersion: { majorVersion: 25 }, downloads: { client: artifact }, libraries: [library] }));
  const checksum = 'b'.repeat(64);
  const source: JavaSource = {
    version: '26.3', majorVersion: 25, manifest: { url: 'https://example.test/version.json', sha1: hash(bytes, 'sha1'), sha256: hash(bytes) },
    client: { name: 'client', ...artifact, sha256: checksum }, libraries: [{ name: library.name, ...library.downloads.artifact, sha256: checksum }],
  };

  assert.equal(validateJavaManifest(source, bytes).id, '26.3');
  assert.throws(() => validateJavaManifest({ ...source, libraries: [] }, bytes), /libraries differ/);
  assert.throws(() => validateJavaManifest({ ...source, client: { ...source.client, size: 5 } }, bytes), /libraries differ/);
  assert.throws(() => validateJavaManifest({ ...source, manifest: { ...source.manifest, sha1: 'b'.repeat(40) } }, bytes), /manifest hash/);
});

test('coverage checks reject per-block regressions even when total coverage is unchanged', () => {
  const before: Coverage = {
    schemaVersion: 1, minecraft: '1.26.60.30', sourceBlockStates: 14, generatedBlockStates: 10, fallbackBlockStates: 0,
    fallbacks: [], upstreamBlocks: [], authoredBlocks: [], resolvedAuthoredBlocks: [], authoredItems: [],
    gaps: [{ kind: 'block', id: 'old', reason: 'Missing model', affectedStates: 4 }], issues: [], approximations: [],
  };

  assert.doesNotThrow(() => assertCoverageParity(before, { ...before, gaps: [] }));
  assert.throws(() => assertCoverageParity(before, { ...before, gaps: [{ ...before.gaps[0], id: 'other', affectedStates: 1 }] }), /regresses native coverage/);
  assert.throws(() => assertCoverageParity(before, { ...before, generatedBlockStates: 9 }), /regresses native coverage/);
});

test('concurrent acquisitions share one verified download and cached reads preserve the file', async (t) => {
  const cache = await mkdtemp(join(tmpdir(), 'bc-pinned-input-'));

  t.after(() => rm(cache, { recursive: true, force: true }));
  const bytes = Buffer.from('checked'), source = { url: 'https://example.test/input', sha256: hash(bytes) };
  let requests = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    requests++;

    return new Response(bytes);
  });
  const [a, b] = await Promise.all([lockedInput(source, cache), lockedInput(source, cache)]);

  assert.deepEqual(a, bytes);
  assert.deepEqual(b, bytes);
  assert.equal(requests, 1);
  const file = join(cache, source.sha256), before = await stat(file);

  assert.deepEqual(await lockedInput(source, cache, { offline: true }), bytes);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await writeFile(file, 'corrupted');
  await assert.rejects(lockedInput(source, cache, { offline: true }), /hash or size mismatch/);
});

test('block texture inference cannot select an item icon with identical pixels or a forced alias', () => {
  const pixels = image(2, 2, 50), path = 'textures/items/example';
  const args: Parameters<typeof buildTextureNames>[0] = { resources: { sprites: new Map([['block/example', pixels]]), image: (): ImagePixels => pixels, blockstates: {}, models: {} },
    defaults: { javaVersion: '26.3', blocks: {} }, mappings: {},
    native: { blocks: {}, items: {}, entities: {}, models: {}, textures: {} },
    images: new Map([[path, { ...pixels, frame: [0, 0, 2, 2], method: 'opaque' }]]), rules: { aliases: {} } };
  const result = buildTextureNames(args);

  assert.equal(result.mappings['block/example'], undefined);
  assert.equal(result.resolve('block/example'), undefined);
  assert.equal(result.resolve('item/example'), path);
  assert.throws(() => buildTextureNames({ ...args, rules: { aliases: { 'block/example': path } } }), /Invalid native texture alias rule/);
});

test('upstream discovery reports missing matching mappings without changing source pins or posting issues', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'bc-source-discovery-'));

  t.after(() => rm(output, { recursive: true, force: true }));
  const file = new URL('../data/sources.json', import.meta.url), before = await readFile(file);
  const source: Sources = JSON.parse(await readFile(file, 'utf8'));
  const candidateTag = 'v1.26.60.31-preview';
  const candidateArchive = source.bedrock.archive.url.replaceAll(source.bedrock.tag, candidateTag);
  const requests: string[] = [];

  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.ok(typeof url === 'string');
    requests.push(url);
    assert.equal(options?.method, undefined);

    if (url.includes('Mojang/bedrock-samples/releases?')) {
      return Response.json([{ tag_name: candidateTag, prerelease: true, assets: [{ name: 'samples-full.zip', browser_download_url: candidateArchive, digest: 'sha256:' + source.bedrock.archive.sha256 }] }]);
    }

    if (url.includes('GeyserMC/mappings-generator/releases?')) {
      return Response.json([]);
    }

    if (url.includes('version_manifest_v2.json')) {
      return Response.json({ latest: { release: source.java.version } });
    }

    if (url.includes('/compare/')) {
      return Response.json({ files: [] });
    }

    throw new Error('Unexpected source request: ' + url);
  });
  const report = await update({ output: join(output, 'report.json'), write: true });

  assert.equal(requests.length, 4);
  assert.equal(report.candidate.version, '26.60.31-preview');
  assert.equal(report.updated, false);
  assert.equal(report.plan.regenerate, false);
  assert.equal(report.plan.issue, true);
  assert.ok(report.plan.reasons.some(reason => reason.includes('Geyser')));
  assert.deepEqual(report.newProblems, []);
  assert.deepEqual(await readFile(file), before);
});
