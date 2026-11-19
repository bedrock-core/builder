import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePackContent, ContentValidationError } from '../packages/validation/src/index.ts';
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
  const resource = path.join(project.root, 'packs/RP');

  await mkdir(cli, { recursive: true });
  await mkdir(resource, { recursive: true });
  await writeFile(path.join(resource, 'manifest.json'), JSON.stringify(manifestFor('resources')));
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

  assert.deepEqual(result.validation.creatorTools.rules, ['JSON', 'PRJINT']);
  assert.deepEqual(result.validation.creatorTools.diagnostics.map(({ pack, rule, severity }) => [pack, rule, severity]), [
    ['gameplay', 'JSON', 'warning'],
    ['assets', 'PRJINT', 'error'],
  ]);
  const previous = await readFile(path.join(project.root, 'dist/BP/loot_tables/example.json'), 'utf8');

  profile.creatorToolsValidation = 'strict';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await writeFile(project.source, '{ "pools": [] }');
  await assert.rejects(runBuild(options), /\[PRJINT\] Dependency is missing/);
  assert.equal(await readFile(path.join(project.root, 'dist/BP/loot_tables/example.json'), 'utf8'), previous);
});
