import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import { findOreClient, injectOreEntry, oreTextureMetadata, prepareOreAssets } from '../packages/ui-compiler/src/ore-assets.ts';
import { validateConfig } from '../src/config.ts';
const vanilla = '<html><head><script defer="defer" src="/hbui/gameplay-123.js"></script><link href="/hbui/gameplay-123.css" rel="stylesheet"></head><body><div id="root"></div></body></html>';
const nativeInput = 'function Field(props){const{onChange:changed}=props;const ref={current:props.input};ui("BaseTextField");React.useEffect(()=>{},[]);const keyboard=()=>changed(ref.current.value);return element("fast-input",keyboard);}';

function png(width, height) {
  const buffer = Buffer.alloc(24);

  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.write('IHDR', 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function client(root, entry = vanilla, version = '1.26.7021.0') {
  await put(path.join(root, 'appxmanifest.xml'), `<Package><Identity Name="Microsoft.MinecraftUWP" Version="${version}" /></Package>`);
  await put(path.join(root, 'data/gui/dist/hbui/gameplay.html'), entry);
  await put(path.join(root, 'data/gui/dist/hbui/gameplay-123.js'), nativeInput);
  await put(path.join(root, 'data/gui/dist/hbui/gameplay-123.css'), '/* fixture css */');
  await put(path.join(root, 'data/fonts/Mojangles.ttf'), 'fixture font, not a native rendering test');
  await put(path.join(root, 'data/resource_packs/vanilla/font/minecraft-ten.ttf'), 'fixture font');
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'builder-ore-assets-'));
  const projectRoot = path.join(root, 'project'), stagedRoot = path.join(root, 'stage'), pack = path.join(stagedRoot, 'RP'), clientRoot = path.join(root, 'client'), resources = path.join(root, 'resources');

  try {
    await client(clientRoot);
    await mkdir(pack, { recursive: true });
    await mkdir(resources, { recursive: true });
    const layout = 'hbui/core-ore/demo.json';

    await put(path.join(pack, layout), JSON.stringify({ schema: 'core-ore-layout/1', nodes: [{ id: 'n', kind: 'button', backgrounds: { normal: 'pack://textures/ui/demo.png' } }] }));
    await put(path.join(resources, 'textures/ui/demo.png'), png(10, 14));
    await put(path.join(resources, 'textures/ui/demo.json'), JSON.stringify({ base_size: [5, 7], nineslice_size: [2, 2, 2, 4] }));
    const inputs = [];

    await run({ root, projectRoot, stagedRoot, pack, clientRoot, resources, layout, inputs, options: { projectRoot, stagedRoot, pack, targetVersion: '1.26.70', layouts: [layout], settings: { clientRoot, resourceRoots: [resources] }, registerDependency: file => inputs.push(file) } });
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

test('links entry, fallback textures, logical nine-slice widths and client fonts without changing sources', async () => fixture(async (f) => {
  const before = await readFile(path.join(f.clientRoot, 'data/gui/dist/hbui/gameplay.html'), 'utf8');
  const result = await prepareOreAssets(f.options);

  assert.equal(result.version, '1.26.70.21');
  const layout = JSON.parse(await readFile(path.join(f.pack, f.layout), 'utf8'));

  assert.deepEqual(layout.textures['pack://textures/ui/demo.png'], { size: [10, 14], base: [5, 7], slice: [2, 2, 2, 4] });
  assert.match(await readFile(path.join(f.pack, 'hbui/gameplay.html'), 'utf8'), /core-ore-client\.js/);
  assert.equal(await readFile(path.join(f.pack, 'hbui/core-ore/fonts/mojangles.ttf'), 'utf8'), 'fixture font, not a native rendering test');
  assert.equal(await readFile(path.join(f.clientRoot, 'data/gui/dist/hbui/gameplay.html'), 'utf8'), before);
  assert.deepEqual(await readFile(path.join(f.pack, 'textures/ui/demo.png')), await readFile(path.join(f.resources, 'textures/ui/demo.png')));
  assert(f.inputs.includes(path.join(f.resources, 'textures/ui/demo.json')));
  assert(f.inputs.includes(path.join(f.clientRoot, 'data/gui/dist/hbui/gameplay-123.css')));
  assert(result.files.includes(path.join(f.pack, 'textures/ui/demo.png')));
  const report = await readFile(path.join(f.pack, 'bedrock-core/experimental-ore.json'), 'utf8');

  assert(!report.includes(f.root));
  assert.equal(JSON.parse(report).inputBridge, undefined);
  assert(!result.files.some(file => file.endsWith('gameplay-123.js')));
}));
test('selected RP textures take priority over fallback roots and track authored input paths', async () => fixture(async (f) => {
  await put(path.join(f.pack, 'textures/ui/demo.png'), png(3, 3));
  await prepareOreAssets(f.options);
  const layout = JSON.parse(await readFile(path.join(f.pack, f.layout), 'utf8'));

  assert.deepEqual(layout.textures['pack://textures/ui/demo.png'], { size: [3, 3] });
  assert(f.inputs.includes(path.join(f.projectRoot, 'RP/textures/ui/demo.png')));
  assert(f.inputs.includes(path.join(f.projectRoot, 'RP/textures/ui/demo.json')));
}));

test('copies live image sources and the complete option palette alongside a viewport background', async () => fixture(async (f) => {
  for (const name of ['backdrop', 'selected', 'disabled', 'next']) {
    await put(path.join(f.resources, `textures/ui/${name}.png`), png(8, 8));
  }

  f.options.settings.dynamicTextures = ['textures/ui/next'];
  await put(path.join(f.pack, f.layout), JSON.stringify({ schema: 'core-ore-layout/1', background: 'pack://textures/ui/backdrop.png',
    nodes: [{ resources: ['pack://textures/ui/selected.png', 'pack://textures/ui/disabled.png'] }] }));
  await prepareOreAssets(f.options);
  const layout = JSON.parse(await readFile(path.join(f.pack, f.layout), 'utf8'));

  assert.deepEqual(Object.keys(layout.textures).sort(), ['backdrop', 'disabled', 'selected'].map(name => `pack://textures/ui/${name}.png`));

  for (const name of ['backdrop', 'selected', 'disabled', 'next']) {
    assert.deepEqual(await readFile(path.join(f.pack, `textures/ui/${name}.png`)), await readFile(path.join(f.resources, `textures/ui/${name}.png`)));
    assert(f.inputs.includes(path.join(f.resources, `textures/ui/${name}.png`)));
  }
}));

test('links field checked, progress, thumb and popup surfaces from the same resource roots', async () => fixture(async (f) => {
  const surfaces = Object.fromEntries(['checkedBackground', 'progress', 'thumb', 'popupBackground'].map((key, index) => [key, `pack://textures/ui/field_${index}.png`]));

  for (let index = 0; index < 4; index++) {
    await put(path.join(f.resources, `textures/ui/field_${index}.png`), png(5, 5));
  }

  await put(path.join(f.pack, f.layout), JSON.stringify({ schema: 'core-ore-layout/1', nodes: [{ kind: 'field', field: { surfaces } }] }));
  await prepareOreAssets(f.options);
  const layout = JSON.parse(await readFile(path.join(f.pack, f.layout), 'utf8'));

  assert.deepEqual(Object.keys(layout.textures).sort(), Object.values(surfaces).sort());
  assert(f.inputs.includes(path.join(f.resources, 'textures/ui/field_2.png')));
  const report = JSON.parse(await readFile(path.join(f.pack, 'bedrock-core/experimental-ore.json'), 'utf8'));

  assert.equal(report.inputBridge.schema, 'core-ore-native-input/1');
  assert.equal(report.inputBridge.bundle, 'hbui/gameplay-123.js');
  assert.notEqual(report.inputBridge.sourceSha256, report.inputBridge.outputSha256);
  assert.match(await readFile(path.join(f.pack, report.inputBridge.bundle), 'utf8'), /__coreOreBindNativeInput/);
  assert.equal(await readFile(path.join(f.clientRoot, 'data/gui/dist/hbui/gameplay-123.js'), 'utf8'), nativeInput);
}));

test('unsupported live input bundles and authored bundle overrides fail before publication', async () => fixture(async (f) => {
  await put(path.join(f.pack, f.layout), JSON.stringify({ schema: 'core-ore-layout/1', nodes: [{ field: { kind: 'input' } }] }));
  await put(path.join(f.clientRoot, 'data/gui/dist/hbui/gameplay-123.js'), '/* unsupported component */');
  await assert.rejects(prepareOreAssets(f.options), /Unsupported Ore text-field bundle/);
}));

test('live input bundle ownership preserves authored files', async () => fixture(async (f) => {
  await put(path.join(f.pack, f.layout), JSON.stringify({ schema: 'core-ore-layout/1', nodes: [{ field: { kind: 'input' } }] }));
  await put(path.join(f.pack, 'hbui/gameplay-123.js'), 'authored bundle');
  await assert.rejects(prepareOreAssets(f.options), /cannot replace an authored hbui\/gameplay-123.js/);
  assert.equal(await readFile(path.join(f.pack, 'hbui/gameplay-123.js'), 'utf8'), 'authored bundle');
}));
test('missing textures and path traversal fail before publication', async () => fixture(async (f) => {
  f.options.settings.resourceRoots = [];
  await assert.rejects(prepareOreAssets(f.options), /Missing Ore texture/);
  await put(path.join(f.pack, f.layout), JSON.stringify({ schema: 'core-ore-layout/1', nodes: [{ source: 'pack://textures/../private.png' }] }));
  await assert.rejects(prepareOreAssets(f.options), /pack-local PNG/);
}));
test('authored entry overrides are preserved and conflicting ownership fails', async () => fixture(async (f) => {
  await put(path.join(f.pack, 'hbui/gameplay.html'), 'authored override');
  await assert.rejects(prepareOreAssets(f.options), /authored hbui\/gameplay/);
  assert.equal(await readFile(path.join(f.pack, 'hbui/gameplay.html'), 'utf8'), 'authored override');
}));
test('explicit clients enforce the target release and complete native assets', async () => fixture(async (f) => {
  await assert.rejects(findOreClient(f.projectRoot, '1.26.60', f.clientRoot), /does not match/);
  await rm(path.join(f.clientRoot, 'data/gui/dist/hbui/gameplay-123.css'));
  await assert.rejects(findOreClient(f.projectRoot, '1.26.70', f.clientRoot), /ENOENT/);
}));
test('automatic discovery rejects different matching entry pages and permits identical copies', async () => fixture(async (f) => {
  const search = path.join(f.root, 'search');

  await client(path.join(search, 'one/Content'));
  await client(path.join(search, 'two/Content'), vanilla.replace('<body>', '<body class="different">'));
  await assert.rejects(findOreClient(f.projectRoot, '1.26.70', undefined, [search]), /Different installed Ore/);
  await client(path.join(search, 'two/Content'));
  assert.equal((await findOreClient(f.projectRoot, '1.26.70', undefined, [search])).version, '1.26.70.21');
}));
test('preserves native entry tags and independently reports a missing adapter', () => {
  const patched = injectOreEntry(vanilla);

  assert(patched.startsWith(vanilla.slice(0, vanilla.indexOf('</body>'))));
  assert.equal((patched.match(/id="root"/g) || []).length, 1);
  assert.throws(() => injectOreEntry(patched), /unmodified/);
  assert.throws(() => injectOreEntry('<html><body></body></html>'));
  let timeout;
  const badge = { textContent: '' }, window = { setTimeout: (callback) => {
    timeout = callback;
  } };

  new Script(patched.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({ window, document: { getElementById: () => badge } });
  timeout();
  assert.match(badge.textContent, /adapter script did not start/);
  badge.textContent = 'client status';
  window.__coreOreInstalled = true;
  timeout();
  assert.equal(badge.textContent, 'client status');
});
test('validates scalar, paired and asymmetric slice data in logical units', () => {
  assert.deepEqual(oreTextureMetadata(png(10, 14), { base_size: [5, 7], nineslice_size: [2, 2, 2, 4] }), { size: [10, 14], base: [5, 7], slice: [2, 2, 2, 4] });
  assert.deepEqual(oreTextureMetadata(png(10, 14), { nineslice_size: 2 }).slice, [2, 2, 2, 2]);
  assert.deepEqual(oreTextureMetadata(png(10, 14), { nineslice_size: [2, 3] }).slice, [2, 3, 2, 3]);
  assert.throws(() => oreTextureMetadata(Buffer.alloc(24)), /PNG/);
  assert.throws(() => oreTextureMetadata(png(0, 7)), /dimensions/);

  for (const nineslice_size of [[1, 2, 3], [-1, 1, 1, 1], [4, 4, 4, 4]]) {
    assert.throws(() => oreTextureMetadata(png(5, 7), { nineslice_size }));
  }
});
test('experimental Ore configuration accepts explicit roots and rejects unknown or empty settings', async () => {
  const config = JSON.parse(await readFile(new URL('../examples/script-only/config.json', import.meta.url), 'utf8'));
  const profile = config.bedrockCore.profiles.default;

  profile.stages['ui-compiler'] = { experimentalOre: { clientRoot: 'C:/client', resourceRoots: ['../shared/RP'] } };
  validateConfig(config);

  for (const settings of [{ clientRoot: '' }, { resourceRoots: [1] }, { resourceRoots: [''] }, { unknown: true }]) {
    profile.stages['ui-compiler'].experimentalOre = settings;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});
