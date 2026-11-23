import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePackContent, ContentValidationError } from '../packages/validation/src/index.ts';
import { prepareCheckedDocument } from '../packages/validation/src/document-rules.ts';
import { runBuild } from '../src/run.ts';
import { manifestFor } from '../test-support/manifest.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-validation-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packs/BP/loot_tables'), { recursive: true });
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifestFor('data')));
  const source = path.join(root, 'packs/BP/loot_tables/example.json');
  const config = {
    name: 'Validation', authors: [],
    targetVersion: '1.26.50', packs: { gameplay: './packs/BP' },
    bedrockCore: { formatVersion: '1.0.0', profiles: { default: { validation: 'strict', export: { gameplay: './dist/BP' } } } },
  };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, source, config, configPath, mode: 'strict', packs: [{ id: 'gameplay', path: path.join(root, 'packs/BP'), kind: 'behavior' }] };
}

async function writeDocument(project, file, document) {
  const target = path.join(project.packs[0].path, file);

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(document));

  return target;
}

test('document validation checks nested types and supports JSON comments', async (t) => {
  const project = await fixture(t);

  await writeFile(project.source, '{ "pools": [{ /* pool */ "rolls": 1, "entries": [{"type":"item","name":"minecraft:apple","weight":1}], }], }');
  const result = await validatePackContent(project);

  assert.equal(result.typesVersion, '26.50.5');
  assert.equal(result.files[0].category, 'bp/loot_tables');
  const second = path.join(path.dirname(project.source), 'second.json');

  await writeFile(second, '{"pools":[{"rolls":1,"entries":[{"type":"item","name":"validation:🍎","weight":"invalid"}]}]}');
  await writeFile(project.source, '{"pools":[{"rolls":"invalid","entries":[]}]}');
  await assert.rejects(validatePackContent(project), (error) => {
    assert.ok(error instanceof ContentValidationError);
    assert.deepEqual(error.diagnostics.map(({ file, pointer }) => [file, pointer]), [
      ['loot_tables/example.json', '/pools/0/rolls'],
      ['loot_tables/second.json', '/pools/0/entries/0/weight'],
    ]);

    return true;
  });
});

test('block validation registers declaration inputs and rejects invalid components', async (t) => {
  const project = await fixture(t);
  const blocks = path.join(project.packs[0].path, 'blocks');
  const file = path.join(blocks, 'container.json');

  await mkdir(blocks);
  await writeFile(file, JSON.stringify({ 'format_version': '1.21.120', 'minecraft:block': {
    description: { identifier: 'validation:owned_container' }, components: { 'minecraft:friction': 0.6 },
  } }));
  const dependencies = new Set();
  const result = await validatePackContent({ ...project, reuse: async (_file, inputs, _revision, validate) => {
    inputs.forEach(input => dependencies.add(input));

    return validate();
  } });
  const block = result.files.find(entry => entry.file === 'blocks/container.json');

  assert.equal(block.category, 'bp/blocks');
  assert.ok([...dependencies].some(input => input.endsWith('components.d.ts')));
  await writeFile(file, JSON.stringify({ 'format_version': '1.21.120', 'minecraft:block': {
    description: { identifier: 'validation:owned_container' }, components: { 'minecraft:friction': 'invalid' },
  } }));
  await assert.rejects(validatePackContent(project), ContentValidationError);
});

test('block state definitions check their value type, uniqueness, integer bounds and cardinality', async (t) => {
  const project = await fixture(t);
  const document = {
    'format_version': '1.26.50',
    'minecraft:block': {
      description: { identifier: 'validation:stateful', states: { 'validation:level': { values: { min: -4, max: 11 } }, 'validation:open': [false, true] } },
    },
  };

  await writeDocument(project, 'blocks/stateful.json', document);
  await validatePackContent(project);

  document['minecraft:block'].description.states = {
    'validation:duplicate': [1, 1],
    'validation:fraction': [1.5],
    'validation:mixed': [true, 'open'],
    'validation:too_many': Array.from({ length: 17 }, (_, index) => index),
    'validation:wide_range': { values: { min: 0, max: 16 } },
  };
  await writeDocument(project, 'blocks/stateful.json', document);
  const result = await validatePackContent({ ...project, mode: 'warn' });

  for (const key of Object.keys(document['minecraft:block'].description.states)) {
    assert.ok(result.files[0].diagnostics.some(issue => issue.pointer.startsWith('/minecraft:block/description/states/' + key)), key);
  }
});

test('block rules enforce root placement and numeric limits while accepting legacy ambient occlusion', async (t) => {
  const project = await fixture(t);
  const components = {
    'minecraft:material_instances': { '*': { texture: 'stone', ambient_occlusion: true } },
  };
  const block = (version, overrides) => ({
    'format_version': version,
    'minecraft:block': { description: { identifier: 'validation:block' }, components: overrides },
  });
  const legacy = block('1.21.80', components);
  const legacyPath = await writeDocument(project, 'blocks/legacy.json', legacy);

  await validatePackContent(project);
  assert.deepEqual(JSON.parse(await readFile(legacyPath, 'utf8')), legacy);
  await writeDocument(project, 'blocks/boolean.json', block('1.26.50', components));
  const invalid = block('1.26.50', {
    'minecraft:material_instances': { '*': { texture: 'stone', ambient_occlusion: 11 } },
    'minecraft:redstone_consumer': { min_power: 15.5 },
  });

  invalid['minecraft:block'].permutations = [{ condition: '1', components: { 'minecraft:flower_pottable': {}, 'minecraft:redstone_consumer': {} } }];
  await writeDocument(project, 'blocks/invalid.json', invalid);
  const result = await validatePackContent({ ...project, mode: 'warn' });

  assert.deepEqual(result.files.find(file => file.file === 'blocks/invalid.json').diagnostics.map(issue => issue.pointer).sort(), [
    '/minecraft:block/components/minecraft:material_instances/*/ambient_occlusion',
    '/minecraft:block/components/minecraft:redstone_consumer/min_power',
    '/minecraft:block/permutations/0/components/minecraft:flower_pottable',
    '/minecraft:block/permutations/0/components/minecraft:redstone_consumer',
  ]);
  assert.equal(result.files.find(file => file.file === 'blocks/boolean.json').diagnostics[0].pointer,
    '/minecraft:block/components/minecraft:material_instances/*/ambient_occlusion');
});

test('custom V2 component registrations preserve native checks in items and block permutations', async (t) => {
  const project = await fixture(t);
  const block = {
    'format_version': '1.26.50',
    'minecraft:block': {
      description: { identifier: 'validation:block' },
      components: { 'validation:registered': {}, 'validation:nullable': null },
      permutations: [{ condition: '1', components: { 'validation:registered': { amount: 2 }, 'minecraft:friction': 0.5 } }],
    },
  };
  const item = {
    'format_version': '1.26.50',
    'minecraft:item': { description: { identifier: 'validation:item' }, components: { 'validation:registered': { values: [[1, 2]], nullable: null } } },
  };

  await writeDocument(project, 'blocks/custom.json', block);
  await writeDocument(project, 'items/custom.json', item);
  const valid = await validatePackContent(project);

  assert.equal(valid.files.length, 2);
  block['minecraft:block'].permutations[0].components['minecraft:friction'] = 'wrong';
  block['minecraft:block'].permutations[0].components['validation:registered'] = { a: { b: { c: 1 } } };
  item['minecraft:item'].components['validation:registered'] = { values: [[{ amount: 1 }]] };
  item['minecraft:item'].components['minecraft:unknown_component'] = {};
  item['minecraft:item'].components['validation:nullable'] = null;
  await writeDocument(project, 'blocks/custom.json', block);
  await writeDocument(project, 'items/custom.json', item);
  const result = await validatePackContent({ ...project, mode: 'warn' });

  assert.deepEqual(result.files.flatMap(file => file.diagnostics.map(issue => issue.pointer)).sort(), [
    '/minecraft:block/permutations/0/components/minecraft:friction',
    '/minecraft:block/permutations/0/components/validation:registered/a/b',
    '/minecraft:item/components/minecraft:unknown_component',
    '/minecraft:item/components/validation:nullable',
    '/minecraft:item/components/validation:registered/values/0/0',
  ]);
});

test('neighbor directions permit duplicates, require one to six entries and separate all from individual faces', () => {
  const cases = [
    [[], false],
    [['all'], true],
    [['all', 'all'], true],
    [['all', 'north'], false],
    [['north', 'north'], true],
    [['north', 'south', 'east', 'west', 'up', 'down', 'north'], false],
  ];

  for (const [neighbor_directions, valid] of cases) {
    const issues = [];

    prepareCheckedDocument('bp/blocks', {
      'format_version': '1.26.60',
      'minecraft:block': { components: { 'minecraft:neighbor_change': { neighbor_directions } } },
    }, pointer => issues.push(pointer));
    assert.deepEqual(issues, valid ? [] : ['/minecraft:block/components/minecraft:neighbor_change/neighbor_directions']);
  }
});

test('checks authoring shapes for the supplemental behavior pack documents', async (t) => {
  const project = await fixture(t);
  const description = { identifier: 'validation:definition' };
  const cases = [
    ['cameras/presets/test.json', 'minecraft:camera_preset', { identifier: description.identifier, inherit_from: 'minecraft:free', rot_x: 10 }],
    ['dimensions/test.json', 'minecraft:dimension', { description, components: { 'minecraft:generation': { generator_type: 'void' } } }],
    ['item_catalog/crafting_item_catalog.json', 'minecraft:crafting_items_catalog', { categories: [{ category_name: 'items', groups: [{ items: ['minecraft:stick'] }] }] }],
    ['sounds/server_sound_definitions.json', 'minecraft:server_sound_definitions', [{ sound_event_name: 'validation.sound', duration_info: { mode: 'game_time', seconds: 2 } }]],
    ['worldgen/jigsaw_structures/test.json', 'minecraft:jigsaw', { description, start_pool: 'validation:pool', start_height: { type: 'constant', value: { absolute: 64 } }, max_depth: 6, step: 'surface_structures' }],
    ['worldgen/processors/test.json', 'minecraft:processor_list', { description, processors: [{ processor_type: 'minecraft:block_ignore', blocks: ['minecraft:air'] }] }],
    ['worldgen/structure_sets/test.json', 'minecraft:structure_set', { description, placement: { type: 'minecraft:random_spread', spacing: 30, separation: 9, salt: 5 }, structures: [{ structure: 'validation:structure', weight: 1 }] }],
    ['worldgen/template_pools/test.json', 'minecraft:template_pool', { description, elements: [{ element: { element_type: 'minecraft:single_pool_element', location: 'validation:wood' } }] }],
  ];

  for (const [file, key, payload] of cases) {
    await writeDocument(project, file, { format_version: '1.26.50', [key]: payload });
  }

  await writeDocument(project, 'cameras/presets/aim.json', { 'minecraft:aim_assist_preset': { identifier: 'validation:aim' } });
  const valid = await validatePackContent(project);

  assert.equal(valid.files.filter(file => file.category).length, cases.length);
  assert.equal(valid.files.find(file => file.file.endsWith('/aim.json')).category, undefined);

  for (const [file, key] of cases) {
    const payload = key === 'minecraft:dimension'
      ? { description, components: {
          'minecraft:dimension_height': { min_y: -511, height_range: 1024 },
          'minecraft:clouds': { height: 513 },
        } }
      : false;

    await writeDocument(project, file, { format_version: '1.26.50', [key]: payload });
  }

  const invalid = await validatePackContent({ ...project, mode: 'warn' });

  assert.equal(invalid.files.filter(file => file.diagnostics.length > 0).length, cases.length);
  assert.deepEqual(invalid.files.find(file => file.file === 'dimensions/test.json').diagnostics.map(issue => issue.pointer), [
    '/minecraft:dimension/components/minecraft:generation',
    '/minecraft:dimension/components/minecraft:dimension_height',
    '/minecraft:dimension/components/minecraft:clouds/height',
  ]);
});

test('entity version checks require contiguous versions and names in the upgrade handler map', async (t) => {
  const project = await fixture(t);
  const file = path.join(project.packs[0].path, 'entities/robot.json');
  const entity = {
    description: {
      identifier: 'validation:robot',
      properties: { 'validation:ready': { type: 'bool', default: false } },
      entity_version: { upgrades: [
        { upgrade_to: 1, name: 'validation:first' },
        { upgrade_to: 2, name: 'validation:second' },
      ] },
    },
    events: { 'validation:ordinary': {} },
    upgrades: { 'validation:first': {}, 'validation:second': { set_property: { 'validation:ready': true } } },
  };
  const document = { 'format_version': '1.26.20', 'minecraft:entity': entity };

  await mkdir(path.dirname(file));
  await writeFile(file, JSON.stringify(document));
  const valid = await validatePackContent(project);

  assert.deepEqual(valid.files.find(entry => entry.file === 'entities/robot.json').diagnostics, []);

  for (const upgrade_to of [0, 1, 1.5, 3]) {
    entity.description.entity_version.upgrades[1] = { upgrade_to, name: 'validation:ordinary' };
    await writeFile(file, JSON.stringify(document));
    await assert.rejects(validatePackContent(project), (error) => {
      assert.ok(error instanceof ContentValidationError);
      assert.deepEqual(error.diagnostics.map(issue => issue.pointer), [
        '/minecraft:entity/description/entity_version/upgrades/1/upgrade_to',
        '/minecraft:entity/description/entity_version/upgrades/1/name',
      ]);

      return true;
    });
  }

  entity.description.entity_version.upgrades[1] = { upgrade_to: 2, name: 'validation:second' };
  await writeFile(file, JSON.stringify({ ...document, format_version: '1.26.19' }));
  await assert.rejects(validatePackContent(project), /requires format_version 1\.26\.20 or later/);
});

test('terrain atlas type validation accepts single paths and path arrays while rejecting invalid values', async (t) => {
  const project = await fixture(t);
  const resource = path.join(project.root, 'packs/RP');
  const file = path.join(resource, 'textures/terrain_texture.json');
  const options = { mode: 'strict', packs: [{ id: 'assets', path: resource, kind: 'resource' }] };
  const atlas = { resource_pack_name: 'validation', texture_name: 'atlas.terrain', texture_data: {
    stone: { textures: 'textures/blocks/stone' },
    variants: { textures: ['textures/blocks/stone', 'textures/blocks/dirt'] },
  } };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(atlas));
  const result = await validatePackContent(options);

  assert.equal(result.files[0].category, 'rp/textures/terrain_texture');

  for (const invalid of [42, ['textures/blocks/stone', 42], { invalid: true }]) {
    atlas.texture_data.stone.textures = invalid;
    await writeFile(file, JSON.stringify(atlas));
    await assert.rejects(validatePackContent(options), ContentValidationError);
  }
});

test('type checking selects the installed release matching the target', async (t) => {
  const project = await fixture(t);
  const options = { ...project, projectRoot: project.root, targetVersion: '1.26.60' };
  const installed = path.join(project.root, 'node_modules/@bedrock-core/bedrock-types');

  await writeFile(project.source, '{"pools":[42]}');
  const warned = await validatePackContent({ ...options, mode: 'warn' });

  assert.equal(warned.typesVersion, '');
  assert.match(warned.typesIssue, /matching .*Bedrock 1.26.60/);
  await assert.rejects(validatePackContent(options), /matching .*Bedrock 1.26.60/);
  await mkdir(path.join(installed, 'dist'), { recursive: true });
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: '@bedrock-core/bedrock-types', version: '26.60.5' }));
  await writeFile(path.join(installed, 'dist/documents.d.ts'), 'export interface DocumentTypes { \'bp/loot_tables\': { pools: number[] } }');
  const result = await validatePackContent(options);

  assert.equal(result.typesVersion, '26.60.5');
  assert.equal(result.files[0].category, 'bp/loot_tables');
  await writeFile(project.source, '{"pools":["invalid"]}');
  await assert.rejects(validatePackContent(options), /TS2322/);
});

test('resource pack localization outside DocumentTypes still receives syntax checks', async (t) => {
  const project = await fixture(t);
  const resource = path.join(project.root, 'packs/RP');
  const file = path.join(resource, 'texts/languages.json');
  const options = { mode: 'strict', packs: [{ id: 'assets', path: resource, kind: 'resource' }] };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '["en_US","es_ES"]');
  const result = await validatePackContent(options);

  assert.equal(result.files[0].category, undefined);
  assert.deepEqual(result.files[0].diagnostics, []);
  await writeFile(file, '["en_US",');
  await assert.rejects(validatePackContent(options), ContentValidationError);
});

test('unknown JSON receives syntax validation and reports type coverage accurately', async (t) => {
  const project = await fixture(t);
  const unknown = path.join(project.packs[0].path, 'custom.json');

  await writeFile(unknown, '{"custom":true}');
  const result = await validatePackContent(project);

  assert.equal(result.files[0].category, undefined);
  await writeFile(unknown, '{"custom":}');
  await assert.rejects(validatePackContent(project), /gameplay\/custom.json/);
});

test('validation profiles warn or skip type errors while invalid JSON stays fatal', async (t) => {
  const project = await fixture(t);
  const warnings = [];
  const options = { configPath: project.configPath, logger: { warn: message => warnings.push(message) } };

  const setMode = async (mode) => {
    project.config.bedrockCore.profiles.default.validation = mode;
    await writeFile(project.configPath, JSON.stringify(project.config));
  };

  await writeFile(project.source, '{"pools":[{"rolls":"invalid","entries":[]}]}');
  await setMode('warn');
  const warned = await runBuild(options);

  assert.ok(warned.validation.files[0].diagnostics.some(issue => issue.kind === 'type' && issue.pointer === '/pools/0/rolls'));
  assert.ok(warnings.some(message => message.includes('gameplay/loot_tables/example.json/pools/0/rolls')));
  await setMode('strict');
  await assert.rejects(runBuild(options), ContentValidationError);
  await setMode('skip');
  const skipped = await runBuild(options);

  assert.equal(skipped.validation.typesVersion, '');
  assert.equal(skipped.validation.files[0].category, undefined);
  assert.deepEqual(skipped.validation.files[0].diagnostics, []);
  await validatePackContent({ ...project, mode: 'skip', typesRoot: path.join(project.root, 'missing-types') });
  await writeFile(project.source, '{"pools":}');
  await assert.rejects(runBuild(options), ContentValidationError);
  await setMode('warn');
  await assert.rejects(runBuild(options), ContentValidationError);
});

test('type diagnostics warn by default in the runner and standalone API while syntax and manifests stay fatal', async (t) => {
  const project = await fixture(t);
  const warnings = [];

  delete project.mode;
  delete project.config.bedrockCore.profiles.default.validation;
  await writeFile(project.configPath, JSON.stringify(project.config));
  await writeFile(project.source, '{"pools":[{"rolls":"invalid","entries":[]}]}');
  const result = await validatePackContent(project);

  assert.ok(result.files[0].diagnostics.some(issue => issue.kind === 'type'));
  const built = await runBuild({ configPath: project.configPath, logger: { warn: message => warnings.push(message) } });

  assert.ok(warnings.some(message => message.includes('/pools/0/rolls')));
  assert.equal(await readFile(path.join(built.outputPaths.gameplay, 'loot_tables/example.json'), 'utf8'), '{"pools":[{"rolls":"invalid","entries":[]}]}');
  await assert.rejects(validatePackContent({ ...project, mode: 'strict' }), ContentValidationError);
  await writeFile(project.source, '{invalid JSON');
  await assert.rejects(validatePackContent(project), ContentValidationError);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), ContentValidationError);
  await writeFile(project.source, '{"pools":[]}');
  await writeFile(path.join(project.packs[0].path, 'manifest.json'), '{"header":{}}');
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /needs an authored header and modules/);
});

test('pinned sound definitions accept path strings and validate named sound objects', async (t) => {
  const project = await fixture(t);
  const resource = path.join(project.root, 'packs/RP');
  const file = path.join(resource, 'sounds/sound_definitions.json');
  const options = { mode: 'strict', packs: [{ id: 'assets', path: resource, kind: 'resource' }] };
  const write = sounds => writeFile(file, JSON.stringify({ format_version: '1.14.0', sound_definitions: {
    'ui.example': { category: 'ui', sounds },
  } }));

  await mkdir(path.dirname(file), { recursive: true });
  await write(['sounds/ui/example', { name: 'sounds/ui/other', volume: 0.5, pitch: [0.9, 1] }]);
  const result = await validatePackContent(options);

  assert.equal(result.files[0].category, 'rp/sounds');

  for (const invalid of [17, { volume: 1 }, { name: 'sounds/ui/other', pitch: 'high' }]) {
    await write([invalid]);
    await assert.rejects(validatePackContent(options), ContentValidationError);
  }
});

test('final validation rejects hook output, preserves previous exports and recovers on repair', async (t) => {
  const project = await fixture(t);

  await writeFile(project.source, '{"pools":[{"rolls":1,"entries":[]}]}');
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const output = path.join(project.root, 'dist/BP/loot_tables/example.json');
  const previous = await readFile(output, 'utf8');

  project.config.bedrockCore.plugins = { corrupt: { module: './corrupt.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'corrupt', before: 'export' }];
  await writeFile(path.join(project.root, 'corrupt.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      await writeFile(path.join(context.packs.gameplay, 'loot_tables/example.json'), '{"pools":[{"entries":"invalid"}]}');
    }
  `);
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild(options), /Invalid pack content/);
  assert.equal(await readFile(output, 'utf8'), previous);
  await writeFile(path.join(project.root, 'corrupt.ts'), 'export async function run() {}');
  await runBuild(options);
});

test('validation reuses unchanged files and checks only the edited document', async (t) => {
  const project = await fixture(t);

  await writeFile(project.source, '{"pools":[]}');
  await writeFile(path.join(project.packs[0].path, 'custom.json'), '{}');
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const unchanged = await runBuild(options);

  assert.equal(unchanged.compilations.filter(item => item.id.startsWith('validate/') && item.status === 'cached').length, 2);
  await writeFile(project.source, '{"pools":[{"entries":[]}]}');
  const edited = await runBuild(options);

  assert.equal(edited.compilations.filter(item => item.id.startsWith('validate/') && item.status === 'executed').length, 1);
  assert.equal(edited.compilations.filter(item => item.id.startsWith('validate/') && item.status === 'cached').length, 1);
});

test('entity effect types accept infinite duration and reject other strings', async (t) => {
  const project = await fixture(t);
  const file = path.join(project.packs[0].path, 'entities/display.json');
  const entity = { 'format_version': '1.26.20', 'minecraft:entity': { description: { identifier: 'validation:display' }, components: { 'minecraft:spell_effects': { add_effects: [{ effect: 'invisibility', duration: 'infinite' }] } } } };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(entity));
  await validatePackContent(project);
  entity['minecraft:entity'].components['minecraft:spell_effects'].add_effects[0].duration = 'invalid';
  await writeFile(file, JSON.stringify(entity));
  await assert.rejects(validatePackContent(project), ContentValidationError);
});

test('client entity validation checks all 1,024 mixed render-controller entries', async (t) => {
  const project = await fixture(t);
  const resource = path.join(project.root, 'packs/RP');
  const file = path.join(resource, 'entity/display.entity.json');
  const renderControllers = ['controller.render.main'];

  for (let index = 1; index < 1024; index++) {
    renderControllers.push({ [`controller.render.face_${index}`]: `v.face_${index} == 1` });
  }

  const entity = { 'format_version': '1.10.0', 'minecraft:client_entity': { description: { identifier: 'validation:display', render_controllers: renderControllers } } };
  const options = { mode: 'strict', packs: [{ id: 'assets', path: resource, kind: 'resource' }] };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(entity));
  await validatePackContent(options);
  renderControllers[1023] = 42;
  await writeFile(file, JSON.stringify(entity));
  await assert.rejects(validatePackContent(options), (error) => {
    assert.ok(error instanceof ContentValidationError);
    assert.deepEqual(error.diagnostics.map(issue => issue.pointer), ['/minecraft:client_entity/description/render_controllers/1023']);

    return true;
  });
});

test('geometry types accept numeric vectors and reject string coordinates', async (t) => {
  const project = await fixture(t);
  const resource = path.join(project.root, 'packs/RP');
  const file = path.join(resource, 'models/blocks/housing.geo.json');
  const geometry = { 'format_version': '1.16.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.validation', texture_width: 16, texture_height: 16, visible_bounds_offset: [0, 0.5, 0] }, bones: [{ name: 'housing', pivot: [8, 0, 8], cubes: [{ origin: [0, 0, 0], size: [16, 4, 16], uv: [0, 0] }] }] }] };
  const options = { mode: 'strict', packs: [{ id: 'assets', path: resource, kind: 'resource' }] };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(geometry));
  await validatePackContent(options);
  geometry['minecraft:geometry'][0].bones[0].pivot[0] = '0';
  await writeFile(file, JSON.stringify(geometry));
  await assert.rejects(validatePackContent(options), ContentValidationError);
});

test('Creator Tools runs on the assembled pack set and can block export', async (t) => {
  const project = await fixture(t);
  const cli = path.join(project.root, 'node_modules/@minecraft/creator-tools');
  const sdk = path.join(project.root, 'node_modules/@minecraft/server');
  const resource = path.join(project.root, 'packs/RP');
  const icon = await readFile(new URL('../packages/cli/templates/bedrock-core/packs/RP/pack_icon.png', import.meta.url));
  const texture = path.join(resource, 'textures/example');

  await mkdir(cli, { recursive: true });
  await mkdir(sdk, { recursive: true });
  await mkdir(texture, { recursive: true });
  await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@minecraft/server', version: '2.11.0-beta.1.26.50-stable' }));
  await writeFile(path.join(resource, 'manifest.json'), JSON.stringify(manifestFor('resources')));
  await writeFile(path.join(resource, 'pack_icon.png'), icon);
  await writeFile(path.join(texture, 'pack_icon.png'), icon);
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@minecraft/creator-tools', type: 'module', version: '0.21.0', bin: { mct: './test.js' } }));
  await writeFile(path.join(cli, 'test.js'), `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const input = args[args.indexOf('-i') + 1];
    assert.ok(args.includes('--offline') && args.includes('--single'));
    assert.ok(existsSync(path.join(input, 'behavior_packs/pack-0/manifest.json')));
    assert.ok(existsSync(path.join(input, 'resource_packs/pack-1/manifest.json')));
    console.log(JSON.stringify({ command: 'validate', projects: [{ items: [
      { type: 'warning', generatorId: 'JSON', path: '/behavior_packs/pack-0/loot_tables/example.json', message: 'Structure issue' },
      { type: 'error', generatorId: 'PRJINT', path: '/resource_packs/pack-1/manifest.json', message: 'Dependency is missing' },
      { type: 'error', generatorId: 'CPACKICON', message: 'Found multiple pack icon files for pack-1, there should be only one.' },
      { type: 'error', generatorId: 'SCRIPTMODULE', path: '/behavior_packs/pack-0/manifest.json', message: 'For @minecraft/server, using an out of date beta version 2.11.0-beta compared to the current version' },
      { type: 'error', generatorId: 'SCRIPTMODULE', path: '/behavior_packs/pack-0/manifest.json', message: 'For @minecraft/server, using an out of date beta version 2.10.0-beta compared to the current version' },
    ] }] }));
    process.exitCode = 4;
  `);
  await writeFile(project.source, '{"pools":[]}');
  project.config.packs.assets = './packs/RP';
  const profile = project.config.bedrockCore.profiles.default;

  profile.export.assets = './dist/RP';
  profile.creatorToolsValidation = 'warn';
  await writeFile(project.configPath, JSON.stringify(project.config));
  const options = { configPath: project.configPath, logger: {} };
  const result = await runBuild(options);

  assert.deepEqual(result.validation.creatorTools.rules, ['CPACKICON', 'JSON', 'PRJINT', 'SCRIPTMODULE']);
  assert.deepEqual(result.validation.creatorTools.diagnostics.map(({ pack, rule, severity }) => [pack, rule, severity]), [
    ['gameplay', 'JSON', 'warning'],
    ['assets', 'PRJINT', 'error'],
    ['gameplay', 'SCRIPTMODULE', 'error'],
  ]);
  assert.match(result.validation.creatorTools.diagnostics[2].message, /2\.10\.0-beta/);
  const previous = await readFile(path.join(project.root, 'dist/BP/loot_tables/example.json'), 'utf8');

  profile.creatorToolsValidation = 'strict';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await writeFile(project.source, '{ "pools": [] }');
  icon.writeUInt32BE(129, 16);
  await writeFile(path.join(resource, 'pack_icon.png'), icon);
  await assert.rejects(runBuild(options), (error) => {
    assert.ok(error instanceof ContentValidationError);
    assert.deepEqual(error.diagnostics.map(issue => issue.rule), ['PRJINT', 'CPACKICON', 'SCRIPTMODULE']);

    return true;
  });
  assert.equal(await readFile(path.join(project.root, 'dist/BP/loot_tables/example.json'), 'utf8'), previous);
});
