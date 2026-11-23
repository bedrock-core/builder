import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifestFor } from '../test-support/manifest.js';
import { inspectPacks } from '../packages/plugin/src/packs.ts';
import { collectPackAssets } from '../packages/bundler/src/assets.ts';
import { assetMapsIndex } from '../packages/bundler/src/vanilla.ts';
import { createHash } from 'node:crypto';
import { runBuild } from '../src/run.ts';

async function fixture(t, namespace = 'alpha') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-assets-')));

  t.after(() => rm(root, { recursive: true, force: true }));
  const bp = path.join(root, 'packs/BP');
  const rp = path.join(root, 'packs/RP');
  const extra = path.join(root, 'packs/unrelated');

  const write = async (file, data) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
  };

  const resources = manifestFor('resources');
  const behavior = { ...manifestFor('script', 'scripts/main.ts'), namespace, dependencies: [{ uuid: resources.header.uuid, version: resources.header.version }] };

  await write(path.join(bp, 'manifest.json'), behavior);
  await write(path.join(rp, 'manifest.json'), resources);
  await write(path.join(extra, 'manifest.json'), manifestFor('resources'));
  await write(path.join(root, 'package.json'), { type: 'module' });
  await write(path.join(bp, 'blocks/chair.json'), { 'format_version': '1.21.0', 'minecraft:block': {
    description: { identifier: `${namespace}:chair`, states: { [`${namespace}:active`]: [false, true] } },
    components: { 'minecraft:geometry': 'geometry.chair', 'minecraft:material_instances': { '*': { texture: `${namespace}_wood`, render_method: 'opaque' } } },
    permutations: [{ condition: `query.block_state('${namespace}:active')`, components: { 'minecraft:material_instances': { '*': { texture: `${namespace}_lit`, render_method: 'blend' } } } }],
  } });
  await write(path.join(rp, 'textures/terrain_texture.json'), { resource_pack_name: namespace, texture_name: 'atlas.terrain', texture_data: {
    [`${namespace}_wood`]: { textures: [{ path: `textures/blocks/${namespace}_wood`, weight: 2 }, { path: `textures/blocks/${namespace}_wood_alt`, weight: 1 }] },
    [`${namespace}_lit`]: { textures: `textures/blocks/${namespace}_lit` },
  } });
  await write(path.join(rp, 'textures/flipbook_textures.json'), [{ flipbook_texture: `textures/blocks/${namespace}_lit`, atlas_tile: `${namespace}_lit`, ticks_per_frame: 2 }]);
  await write(path.join(rp, 'blocks.json'), { format_version: '1.1.0', [`${namespace}:chair`]: { textures: { up: `${namespace}_wood`, side: `${namespace}_lit` }, sound: 'wood' } });
  await write(path.join(rp, 'models/blocks/chair.geo.json'), { 'format_version': '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.chair', texture_width: 16, texture_height: 16 }, bones: [{ name: 'root', cubes: [{ origin: [0, 0, 0], size: [8, 8, 8], uv: [0, 0] }] }] }] });
  await write(path.join(rp, 'entity/chair.entity.json'), { 'format_version': '1.10.0', 'minecraft:client_entity': { description: {
    identifier: `${namespace}:display`, geometry: { default: 'geometry.chair' }, textures: { default: `textures/entity/${namespace}_display` }, materials: { default: 'entity_alphatest' }, render_controllers: ['controller.render.chair'],
  } } });
  await write(path.join(rp, 'render_controllers/chair.json'), { format_version: '1.8.0', render_controllers: { 'controller.render.chair': { geometry: 'Geometry.default', textures: ['Texture.default'], materials: [{ '*': 'Material.default' }] } } });
  await write(path.join(extra, 'textures/terrain_texture.json'), { texture_data: { foreign: { textures: 'textures/foreign' } } });
  const packs = await inspectPacks({ gameplay: bp, visuals: rp, unrelated: extra });

  return { root, bp, rp, packs, write, namespace };
}

test('collects linked pack models, texture variants, permutations and entity controller definitions', async (t) => {
  const { packs, namespace } = await fixture(t);
  const { bundle, inputs } = await collectPackAssets(packs[0], packs);

  assert.deepEqual(bundle.textures[`${namespace}_wood`].paths, ['textures/blocks/alpha_wood', 'textures/blocks/alpha_wood_alt']);
  assert.equal(bundle.textures[`${namespace}_lit`].flipbook.ticks_per_frame, 2);
  assert.equal(bundle.models['geometry.chair'].geometry.bones[0].name, 'root');
  assert.equal(bundle.models['geometry.full_block'], undefined);
  assert.equal(bundle.blocks[`${namespace}:chair`]['minecraft:block'].permutations[0].condition, 'query.block_state(\'alpha:active\')');
  assert.equal(bundle.blocks[`${namespace}:chair`].textures.up, 'alpha_wood');
  assert.deepEqual(bundle.entities[`${namespace}:display`]['minecraft:client_entity'].description.render_controllers, ['controller.render.chair']);
  assert.deepEqual(bundle.textures['textures/entity/alpha_display'].paths, ['textures/entity/alpha_display']);
  assert.equal(bundle.textures.foreign, undefined);
  assert.equal(inputs.some(file => file.includes('unrelated')), false);
  assert.equal(Number.isSafeInteger(bundle.revision), true);
});

test('asset revisions are stable and change when authored geometry changes, including JSON comments', async (t) => {
  const { packs, rp, write } = await fixture(t);
  const first = await collectPackAssets(packs[0], packs);
  const same = await collectPackAssets(packs[0], packs);

  assert.equal(same.bundle.revision, first.bundle.revision);
  await write(path.join(rp, 'models/blocks/chair.geo.json'), '// authored model\n{"format_version":"1.12.0","minecraft:geometry":[{"description":{"identifier":"geometry.chair"},"bones":[],}],}');
  const changed = await collectPackAssets(packs[0], packs);

  assert.notEqual(changed.bundle.revision, first.bundle.revision);
  assert.deepEqual(changed.bundle.models['geometry.chair'].geometry.bones, []);
});

test('collects nested texture variations and complete flipbook entries without flattening their definitions', async (t) => {
  const { packs, rp, write } = await fixture(t);
  const definition = { textures: [{ variations: [
    { path: 'textures/blocks/first', weight: 10 },
    { path: 'textures/blocks/second', weight: 20, quad: 1, tint_color: '#ffffff' },
  ] }] };
  const animation = { flipbook_texture: 'textures/blocks/first', atlas_tile: 'alpha_lit', atlas_index: 0, atlas_tile_variant: 1, frames: [0, 2, 1], replicate: 2, blend_frames: false };

  await write(path.join(rp, 'textures/terrain_texture.json'), { resource_pack_name: 'alpha', texture_name: 'atlas.terrain', texture_data: { alpha_lit: definition } });
  await write(path.join(rp, 'textures/flipbook_textures.json'), [animation]);
  const { bundle } = await collectPackAssets(packs[0], packs);

  assert.deepEqual(bundle.textures.alpha_lit.definition, definition);
  assert.deepEqual(bundle.textures.alpha_lit.paths, ['textures/blocks/first', 'textures/blocks/second']);
  assert.deepEqual(bundle.textures.alpha_lit.flipbook, animation);
});

test('rejects invalid texture variants and malformed flipbook entries at the collection boundary', async (t) => {
  const { packs, rp, write } = await fixture(t);
  const atlas = { resource_pack_name: 'alpha', texture_name: 'atlas.terrain', texture_data: { test: { textures: { variations: [{ weight: 1 }] } } } };

  await write(path.join(rp, 'textures/terrain_texture.json'), atlas);
  await assert.rejects(collectPackAssets(packs[0], packs), /Invalid texture definition test/);
  atlas.texture_data.test.textures.variations[0].path = 'textures/blocks/test';
  await write(path.join(rp, 'textures/terrain_texture.json'), atlas);

  for (const invalid of [
    { atlas_tile: 'test' },
    { atlas_tile: 'test', flipbook_texture: 'textures/blocks/test', frames: ['first'] },
  ]) {
    await write(path.join(rp, 'textures/flipbook_textures.json'), [invalid]);
    await assert.rejects(collectPackAssets(packs[0], packs), /Invalid flipbook entry/);
  }
});

test('normalizes authored block default cubes without inventing models for resource-only overrides', async (t) => {
  const { packs, bp, rp, write } = await fixture(t);

  await write(path.join(bp, 'blocks/cube.json'), { 'format_version': '1.21.0', 'minecraft:block': { description: { identifier: 'alpha:cube' } } });
  await write(path.join(rp, 'blocks.json'), { 'format_version': '1.1.0', 'minecraft:oak_stairs': { textures: 'alpha_wood' } });
  const { bundle } = await collectPackAssets(packs[0], packs);

  assert.equal(bundle.blocks['alpha:cube']['minecraft:block'].components['minecraft:geometry'], 'minecraft:geometry.full_block');
  assert.equal(bundle.blocks['alpha:cube'].format_version, '1.21.0');
  assert.equal(bundle.models['minecraft:geometry.full_block'], undefined);
  assert.deepEqual(bundle.blocks['minecraft:oak_stairs']['minecraft:block'].components, {});
  assert.equal(bundle.blocks['minecraft:oak_stairs'].textures, 'alpha_wood');
});

test('keeps item and terrain aliases distinct and preserves exact entity texture references', async (t) => {
  const { packs, rp, write } = await fixture(t);

  await write(path.join(rp, 'textures/item_texture.json'), { texture_data: { alpha_wood: { textures: 'textures/items/wood' } } });
  await write(path.join(rp, 'entity/raw.entity.json'), { 'minecraft:client_entity': { description: { identifier: 'alpha:raw', textures: { default: 'textures\\entity\\raw.png' } } } });
  const { bundle } = await collectPackAssets(packs[0], packs);

  assert.deepEqual(bundle.textures['item:alpha_wood'].paths, ['textures/items/wood']);
  assert.equal(bundle.textures.alpha_wood.paths[0], 'textures/blocks/alpha_wood');
  assert.deepEqual(bundle.textures['textures\\entity\\raw.png'].paths, ['textures/entity/raw']);
  assert.deepEqual(bundle.textures['textures/entity/raw'].paths, ['textures/entity/raw']);
});

test('collects item icon forms, block placer links and carried textures from linked packs', async (t) => {
  const { packs, bp, rp, write } = await fixture(t);

  await write(path.join(rp, 'textures/item_texture.json'), { texture_data: { tool: { textures: 'textures/items/tool' } } });

  for (const [name, icon] of Object.entries({ simple: 'tool', legacy: { texture: 'tool' }, modern: { textures: { default: 'tool' } } })) {
    await write(path.join(bp, `items/${name}.json`), { 'minecraft:item': { description: { identifier: `alpha:${name}` }, components: { 'minecraft:icon': icon } } });
  }

  await write(path.join(bp, 'items/chair.json'), { 'minecraft:item': { description: { identifier: 'alpha:chair' }, components: { 'minecraft:block_placer': { block: 'alpha:chair' } } } });
  await write(path.join(rp, 'blocks.json'), { 'alpha:chair': { textures: 'alpha_wood', carried_textures: 'alpha_lit' }, 'stone': { carried_textures: 'alpha_wood' } });
  const { bundle, inputs, directories } = await collectPackAssets(packs[0], packs);

  for (const name of ['simple', 'legacy', 'modern']) {
    assert.deepEqual(bundle.items[`alpha:${name}`].textures, { default: { id: 'item:tool' } });
  }

  assert.deepEqual(bundle.items['alpha:chair'].block, { id: 'alpha:chair' });
  assert.equal(bundle.blocks['alpha:chair'].carried_textures, 'alpha_lit');
  assert.equal(bundle.blocks['minecraft:stone'].carried_textures, 'alpha_wood');
  assert.equal(bundle.items['minecraft:stone'], undefined);
  assert.ok(inputs.includes(path.join(bp, 'items/modern.json')));
  assert.ok(directories.includes(path.join(bp, 'items')));
});

test('preserves authored native geometry identifiers and block format versions', async (t) => {
  const { packs, bp, write } = await fixture(t);
  const geometries = ['minecraft:geometry.full_block', 'minecraft:geometry.full_block_v1', 'minecraft:geometry.cross'];

  for (const [index, geometry] of geometries.entries()) {
    await write(path.join(bp, `blocks/native-${index}.json`), { 'format_version': '1.26.0', 'minecraft:block': { description: { identifier: `alpha:native_${index}` }, components: { 'minecraft:geometry': geometry } } });
  }

  const { bundle } = await collectPackAssets(packs[0], packs);

  for (const [index, geometry] of geometries.entries()) {
    assert.equal(bundle.blocks[`alpha:native_${index}`]['minecraft:block'].components['minecraft:geometry'], geometry);
    assert.equal(bundle.blocks[`alpha:native_${index}`].format_version, '1.26.0');
    assert.equal(bundle.models[geometry], undefined);
  }
});

test('preserves native permutation conditions and rejects malformed condition objects', async (t) => {
  const { packs, bp, write } = await fixture(t);

  await write(path.join(bp, 'blocks/conditions.json'), { 'minecraft:block': { description: { identifier: 'alpha:conditions' }, permutations: [
    { condition: 1, components: { 'minecraft:light_emission': 1 } },
    { condition: { expression: 'query.block_state(\'alpha:active\')', version: 1 }, components: { 'minecraft:light_emission': 2 } },
    { condition: 'query.unsupported', components: { 'minecraft:light_emission': 3 } },
  ] } });
  const { bundle } = await collectPackAssets(packs[0], packs);

  assert.deepEqual(bundle.blocks['alpha:conditions']['minecraft:block'].permutations.map(permutation => permutation.condition), [1, { expression: 'query.block_state(\'alpha:active\')', version: 1 }, 'query.unsupported']);
  await write(path.join(bp, 'blocks/conditions.json'), { 'minecraft:block': { description: { identifier: 'alpha:conditions' }, permutations: [
    { condition: { unknown: 'query.unknown' }, components: { 'minecraft:light_emission': 3 } },
  ] } });
  await assert.rejects(collectPackAssets(packs[0], packs), /Invalid native block permutation condition/);
});

test('preserves complete client entity JSON and projects block render components and permutations', async (t) => {
  const { packs, bp, rp, write } = await fixture(t);
  const entity = { 'format_version': '1.8.0', 'minecraft:client_entity': { description: {
    identifier: 'alpha:display', geometry: { default: 'geometry.chair' }, textures: { default: 'textures/entity/alpha_display' },
    materials: { default: 'entity_alphatest' }, animations: { idle: 'animation.chair.idle' },
    scripts: { pre_animation: ['variable.visible = 1;'] }, animation_controllers: [{ idle: 'controller.animation.chair' }],
    render_controllers: [{ 'controller.render.chair': 'query.is_baby' }], enable_attachables: true,
  } } };

  await write(path.join(rp, 'entity/chair.entity.json'), entity);
  await write(path.join(bp, 'blocks/chair.json'), { 'format_version': '1.26.50', 'minecraft:block': {
    description: { identifier: 'alpha:chair', menu_category: { category: 'construction' }, states: { 'alpha:active': [false, true] } },
    components: { 'minecraft:geometry': 'geometry.chair', 'minecraft:collision_box': false, 'minecraft:loot': 'loot_tables/chair.json',
      'minecraft:material_instances': { '*': { texture: 'alpha_wood', render_method: 'opaque' } } },
    permutations: [
      { condition: 'q.block_state(\'alpha:active\')', components: { 'minecraft:loot': 'loot_tables/active.json' } },
      { condition: 'q.block_state(\'alpha:active\')', components: { 'minecraft:transformation': { rotation: [0, 90, 0] }, 'minecraft:collision_box': false } },
    ],
  } });
  const { bundle } = await collectPackAssets(packs[0], packs);

  assert.deepEqual(bundle.entities['alpha:display'], entity);
  assert.deepEqual(bundle.blocks['alpha:chair']['minecraft:block'], {
    description: { identifier: 'alpha:chair', states: { 'alpha:active': [false, true] } },
    components: { 'minecraft:geometry': 'geometry.chair', 'minecraft:material_instances': { '*': { texture: 'alpha_wood', render_method: 'opaque' } } },
    permutations: [{ condition: 'q.block_state(\'alpha:active\')', components: { 'minecraft:transformation': { rotation: [0, 90, 0] } } }],
  });
});

test('unrelated Core addons publish their own assets automatically before authored entry evaluation', async (t) => {
  for (const namespace of ['alpha', 'beta']) {
    const { root, bp, rp, write } = await fixture(t, namespace);
    const runtime = path.join(root, 'node_modules/@bedrock-core/server-runtime');

    await write(path.join(runtime, 'package.json'), { name: '@bedrock-core/server-runtime', type: 'module', exports: { '.': './index.js', './assets/publish': './publish.js' } });
    await write(path.join(runtime, 'shared.js'), 'export const packs = new Map();');
    await write(path.join(runtime, 'publish.js'), 'import { packs } from \'./shared.js\'; export function registerGeneratedPackAssets(namespace, serialized) { packs.set(namespace, JSON.parse(serialized)); }');
    await write(path.join(runtime, 'index.js'), 'import { packs } from \'./shared.js\'; export const readAssets = namespace => packs.get(namespace);');
    await write(path.join(bp, 'scripts/main.ts'), `import { readAssets } from '@bedrock-core/server-runtime'; export const assets = readAssets('${namespace}');`);
    const configPath = path.join(root, 'config.json');

    await write(configPath, { name: namespace, authors: [], targetVersion: '1.26.50', packs: { gameplay: path.relative(root, bp), visuals: path.relative(root, rp) }, bedrockCore: { formatVersion: '1.0.0', profiles: { default: { stages: { 'manifest': false, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false }, export: { gameplay: 'dist/BP', visuals: 'dist/RP' } } } } });
    const result = await runBuild({ configPath, logger: {} });
    const executable = path.join(result.outputPaths.gameplay, 'scripts/main.js');
    const { assets } = await import(pathToFileURL(executable).href);

    assert.ok(assets.blocks[`${namespace}:chair`]);
    assert.ok(assets.textures[`${namespace}_wood`]);
    assert.ok(assets.entities[`${namespace}:display`]);
    assert.equal(Object.keys(assets.blocks).length, 1);
    const output = await readFile(executable, 'utf8');

    assert.doesNotMatch(output, /@bedrock-core\/server-runtime/);
    await write(path.join(rp, 'models/blocks/chair.geo.json'), { 'format_version': '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.chair' }, bones: [] }] });
    const rebuilt = await runBuild({ configPath, logger: {} });
    const text = await readFile(path.join(rebuilt.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

    assert.notEqual(text, output);
  }
});

test('composes JSON-only asset maps when opted in and tracks their source bytes', async (t) => {
  const { root, bp, rp, write } = await fixture(t);
  const runtime = path.join(root, 'node_modules/@bedrock-core/server-runtime');
  const maps = path.join(root, 'node_modules/@bedrock-core/asset-maps');

  await write(path.join(runtime, 'package.json'), { name: '@bedrock-core/server-runtime', type: 'module', exports: { '.': './index.js', './assets/publish': './publish.js' } });
  await write(path.join(runtime, 'shared.js'), 'export const packs = new Map();');
  await write(path.join(runtime, 'publish.js'), 'import { packs } from "./shared.js"; export function registerGeneratedPackAssets(namespace, serialized) { packs.set(namespace, JSON.parse(serialized)); }');
  await write(path.join(runtime, 'index.js'), 'import { packs } from "./shared.js"; export const readAssets = namespace => packs.get(namespace);');
  await write(path.join(maps, 'package.json'), { name: '@bedrock-core/asset-maps', exports: { '.': './index.json' } });
  await write(path.join(maps, 'source-lock.json'), { schemaVersion: 1, minecraft: '1.26.50.1' });
  const native = path.join(root, 'native');

  await write(path.join(native, 'entity/pig.entity.json'), { 'format_version': '1.8.0', 'minecraft:client_entity': { description: { identifier: 'minecraft:pig', textures: { default: 'textures/entity/pig' } } } });
  const previous = process.env.MINECRAFT_VANILLA_PACKS;

  process.env.MINECRAFT_VANILLA_PACKS = native;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.MINECRAFT_VANILLA_PACKS;
    } else {
      process.env.MINECRAFT_VANILLA_PACKS = previous;
    }
  });
  const member = 'behavior_pack/items/minecraft/example.json';

  const update = async (alias) => {
    await write(path.join(maps, member), { 'format_version': '1.26.50', 'minecraft:item': { description: { identifier: 'minecraft:example' }, components: { 'minecraft:icon': { textures: { default: alias } } } } });
    const bytes = await readFile(path.join(maps, member));

    await write(path.join(maps, 'index.json'), { schemaVersion: 1, minecraft: '1.26.50.1', files: { [member]: createHash('sha256').update(bytes).digest('hex') } });
  };

  await update('first');
  await write(path.join(bp, 'scripts/main.ts'), 'import { readAssets } from "@bedrock-core/server-runtime"; export const assets = readAssets("alpha");');
  const configPath = path.join(root, 'config.json');
  const config = { name: 'assets', authors: [], targetVersion: '1.26.50', packs: { gameplay: path.relative(root, bp), visuals: path.relative(root, rp) }, bedrockCore: { formatVersion: '1.0.0', profiles: { default: { stages: { 'manifest': false, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false }, export: { gameplay: 'dist/BP', visuals: 'dist/RP' } } } } };

  await write(configPath, config);
  const initial = await runBuild({ configPath, logger: {} }), executable = path.join(initial.outputPaths.gameplay, 'scripts/main.js');

  assert.equal((await import(pathToFileURL(executable).href + '?own')).assets.catalogs, undefined);
  config.bedrockCore.profiles.default.stages.bundler = { vanillaAssets: true };
  await write(configPath, config);
  await runBuild({ configPath, logger: {} });
  const first = await import(pathToFileURL(executable).href + '?first');

  assert.equal(first.assets.catalogs[0].entities['minecraft:pig']['minecraft:client_entity'].description.textures.default, 'textures/entity/pig');
  assert.equal(first.assets.catalogs[0].items['minecraft:example']['minecraft:item'].components['minecraft:icon'].textures.default, 'first');
  const before = await readFile(executable, 'utf8');

  await update('second');
  await runBuild({ configPath, logger: {} });
  assert.notEqual(await readFile(executable, 'utf8'), before);
  const second = await import(pathToFileURL(executable).href + '?second');

  assert.notEqual(first.assets.imports[0].revision, second.assets.imports[0].revision);
  assert.doesNotMatch(await readFile(executable, 'utf8'), /node:fs|generateVanillaAssets/);
  config.targetVersion = '1.26.51';
  await write(configPath, config);
  const warnings = [];

  await runBuild({ configPath, logger: { warn: message => warnings.push(message) } });
  assert.equal((await import(pathToFileURL(executable).href + '?unsupported')).assets.catalogs, undefined);
  assert.equal(warnings.filter(message => message.includes('checked asset maps cover')).length, 1);
});
test('vanilla opt-in requires the JSON asset-map dependency', async (t) => {
  const { root, write } = await fixture(t);

  assert.throws(() => assetMapsIndex(root), /requires @bedrock-core\/asset-maps/);
  await write(path.join(root, 'node_modules/@bedrock-core/asset-maps/package.json'), { name: '@bedrock-core/asset-maps', exports: { '.': './index.json' } });
  await write(path.join(root, 'node_modules/@bedrock-core/asset-maps/index.json'), { schemaVersion: 1, minecraft: '1.26.50.1', files: {} });
  assert.equal(assetMapsIndex(root), path.join(root, 'node_modules/@bedrock-core/asset-maps/index.json'));
});

test('registry exclusions match exact generated files and skip parsing without hiding authored namesakes', async (t) => {
  const { packs, rp, write } = await fixture(t);
  const privateEntity = path.join(rp, 'entity/internal/display.entity.json');
  const privateModel = path.join(rp, 'models/internal/display.geo.json');
  const privateController = path.join(rp, 'render_controllers/internal/display.json');

  await write(privateEntity, 'invalid private producer input is not parsed');
  await write(privateModel, 'invalid private producer input is not parsed');
  await write(privateController, 'invalid private producer input is not parsed');
  await write(path.join(rp, 'entity/authored/display.entity.json'), { 'minecraft:client_entity': { description: { identifier: 'alpha:authored_display', geometry: { default: 'geometry.authored_display' }, textures: { default: 'textures/entity/authored_display' } } } });
  await write(path.join(rp, 'models/authored/display.geo.json'), { 'minecraft:geometry': [{ description: { identifier: 'geometry.authored_display' }, bones: [] }] });
  const collected = await collectPackAssets(packs[0], packs, { excluded: [privateEntity, privateModel, privateController] });

  assert.ok(collected.bundle.entities['alpha:authored_display']);
  assert.ok(collected.bundle.models['geometry.authored_display']);
  assert.ok(collected.bundle.entities['alpha:display']);
  assert.equal(collected.inputs.includes(privateEntity), false);
  assert.equal(collected.inputs.includes(privateModel), false);
  assert.equal(collected.inputs.includes(privateController), false);
});

test('artifact registry opt-outs survive producer cache reuse while all generated files still export', async (t) => {
  const { root, bp, rp, write } = await fixture(t);
  const runtime = path.join(root, 'node_modules/@bedrock-core/server-runtime');

  await write(path.join(runtime, 'package.json'), { name: '@bedrock-core/server-runtime', type: 'module', exports: { '.': './index.js', './assets/publish': './publish.js' } });
  await write(path.join(runtime, 'shared.js'), 'export const packs = new Map();');
  await write(path.join(runtime, 'publish.js'), 'import { packs } from \'./shared.js\'; export function registerGeneratedPackAssets(namespace, serialized) { packs.set(namespace, JSON.parse(serialized)); }');
  await write(path.join(runtime, 'index.js'), 'import { packs } from \'./shared.js\'; export const readAssets = namespace => packs.get(namespace);');
  await write(path.join(bp, 'scripts/main.ts'), 'import { readAssets } from \'@bedrock-core/server-runtime\'; export const assets = readAssets(\'alpha\');');
  await write(path.join(root, 'presentation.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path'; export async function run(ctx){ const output=[]; for(const visibility of ['private','public']){const rp=ctx.packs.visuals; const model=path.join(rp,'models',visibility,'display.geo.json'); const entity=path.join(rp,'entity',visibility,'display.entity.json'); output.push({file:model,id:visibility+'-model',visibility,value:{format_version:'1.12.0','minecraft:geometry':[{description:{identifier:'geometry.'+visibility},bones:[]}]}});output.push({file:entity,id:visibility+'-entity',visibility,value:{format_version:'1.10.0','minecraft:client_entity':{description:{identifier:'alpha:'+visibility,geometry:{default:'geometry.'+visibility},textures:{default:'textures/entity/'+visibility},materials:{default:'entity_alphatest'},render_controllers:['controller.render.default']}}}});} await ctx.reuse('presentation',{inputs:[import.meta.filename],async run(){for(const item of output){await mkdir(path.dirname(item.file),{recursive:true});await writeFile(item.file,JSON.stringify(item.value));}return{value:null,files:output.map(item=>item.file)};}});for(const item of output)await ctx.registerArtifact(item.id,item.file,{assetRegistry:item.visibility==='private'?false:undefined}); }`);
  const configPath = path.join(root, 'config.json');

  await write(configPath, { name: 'assets', authors: [], targetVersion: '1.26.50', packs: { gameplay: path.relative(root, bp), visuals: path.relative(root, rp) }, bedrockCore: { formatVersion: '1.0.0', plugins: { presentation: { module: './presentation.mjs' } }, profiles: { default: { stages: { 'manifest': false, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false }, steps: [{ plugin: 'presentation', before: 'bundler' }], export: { gameplay: 'dist/BP', visuals: 'dist/RP' } } } } });

  for (const run of ['cold', 'warm']) {
    const built = await runBuild({ configPath, logger: {} });
    const executable = path.join(built.outputPaths.gameplay, 'scripts/main.js');
    const { assets } = await import(`${pathToFileURL(executable).href}?${run}`);

    assert.ok(assets.entities['alpha:display']);
    assert.ok(assets.entities['alpha:public']);
    assert.equal(assets.entities['alpha:private'], undefined);
    assert.ok(assets.models['geometry.public']);
    assert.equal(assets.models['geometry.private'], undefined);
    assert.ok(assets.blocks['alpha:chair']);
    assert.equal(assets.textures['textures/entity/private'], undefined);
    assert.equal(built.artifacts.find(artifact => artifact.id === 'private-entity').assetRegistry, false);
    assert.ok(await readFile(path.join(built.outputPaths.visuals, 'entity/private/display.entity.json')));
    assert.ok(await readFile(path.join(built.outputPaths.visuals, 'models/private/display.geo.json')));

    if (run === 'warm') {
      assert.equal(built.compilations.find(compilation => compilation.id.endsWith('presentation')).status, 'cached');
    }
  }
});
