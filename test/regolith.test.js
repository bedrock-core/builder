import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runBuild } from '../src/run.ts';
import { watchBuild } from '../src/watch.ts';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';

const manifestFilter = fileURLToPath(new URL('../../regolith-filters/manifest/', import.meta.url));
const bundlerFilter = fileURLToPath(new URL('../../regolith-filters/bundler/', import.meta.url));

async function fixture(t, { cleanup = true } = {}) {
  const project = await projectFor(t, { cleanup });

  await mkdir(path.join(project.project, 'filters'));
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.js'), 'export const value = 1;');
  await writeFile(path.join(project.project, 'filters/main.cjs'), '');
  project.config.bedrockCore.plugins = { example: { script: './filters/main.cjs' } };
  project.config.bedrockCore.profiles.default.stages = {
    'manifest': false, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false, 'bundler': false,
  };
  project.config.bedrockCore.profiles.default.steps = [{
    plugin: 'example', after: 'prepare',
  }];
  project.save = () => writeFile(project.configPath, JSON.stringify(project.config));
  await project.save();

  return project;
}

async function addPack(project, id, moduleType) {
  const directory = path.join(project.project, 'packs', id);

  await mkdir(directory);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifestFor(moduleType)));
  await writeFile(path.join(directory, 'asset.json'), JSON.stringify({ id }));
  project.config.packs[id] = './packs/' + id;
  project.config.bedrockCore.profiles.default.export[id] = './dist/' + id;
}

test('unmodified CommonJS filters receive Regolith folders, settings, arguments and environment', async (t) => {
  const project = await fixture(t);
  const settings = { text: 'Quotes " and spaces & unicode: ñ', nested: { value: 8 } };
  const argumentsList = ['space value', '"literal quotes"', '$literal&value'];
  const logs = [];
  const errors = [];

  await mkdir(path.join(project.project, 'packs/data'));
  await writeFile(path.join(project.project, 'packs/data/input.json'), '{"value":4}');
  await writeFile(path.join(project.project, 'filters/helper.cjs'), 'module.exports = 3;');
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const helper = require('./helper.cjs');
    const settings = JSON.parse(process.argv[2]);
    const data = JSON.parse(fs.readFileSync('data/input.json', 'utf8'));
    fs.writeFileSync('RP/asset.json', JSON.stringify({ settings, arguments: process.argv.slice(3), helper, value: data.value }));
    fs.writeFileSync('data/shared.json', JSON.stringify({ value: 12 }));
    fs.writeFileSync('BP/filter-result.json', JSON.stringify({ root: process.env.ROOT_DIR, filter: process.env.FILTER_DIR, cwd: process.cwd() }));
    console.log('filter stdout');
    console.error('filter stderr');
  `);
  const step = project.config.bedrockCore.profiles.default.steps[0];

  project.config.bedrockCore.plugins.example.dataPath = './packs/data';
  project.config.bedrockCore.plugins.example.nodeArguments = ['--no-warnings'];
  project.config.bedrockCore.plugins.consume = { script: './filters/consume.mjs' };
  step.settings = settings;
  step.arguments = argumentsList;
  project.config.bedrockCore.profiles.default.steps.push({
    plugin: 'consume', before: 'export',
  });
  await writeFile(path.join(project.project, 'filters/consume.mjs'), `
    import fs from 'node:fs';
    const shared = JSON.parse(fs.readFileSync('data/shared.json', 'utf8'));
    fs.writeFileSync('RP/shared.json', JSON.stringify(shared));
    fs.unlinkSync('BP/scripts/tests.ts');
  `);
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: { info: line => logs.push(line), error: line => errors.push(line) } });
  const exported = JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8'));
  const environment = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'filter-result.json'), 'utf8'));

  assert.deepEqual(exported, { settings, arguments: argumentsList, helper: 3, value: 4 });
  assert.equal(environment.root, project.project);
  assert.equal(environment.filter, project.project);
  assert.notEqual(environment.cwd, project.project);
  assert.deepEqual((await readdir(environment.root)).includes('BP'), false);
  assert.equal(existsSync(environment.cwd), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'shared.json'), 'utf8')), { value: 12 });
  assert.equal(existsSync(path.join(result.outputPaths.gameplay, 'scripts/tests.ts')), false);
  assert.equal(existsSync(path.join(project.project, 'packs/gameplay/scripts/tests.ts')), true);
  assert.equal(await readFile(path.join(project.project, 'packs/visuals/asset.json'), 'utf8'), '{"value":1}');
  assert.equal(existsSync(path.join(project.project, 'packs/data/shared.json')), false);
  assert.ok(logs.includes('filter stdout'));
  assert.ok(errors.includes('filter stderr'));
});

test('empty settings preserve positional argv and a resource-only filter gets an empty BP directory', async (t) => {
  const project = await fixture(t);

  delete project.config.packs.gameplay;
  delete project.config.bedrockCore.profiles.default.export.gameplay;
  project.config.bedrockCore.profiles.default.steps[0].settings = {};
  project.config.bedrockCore.profiles.default.steps[0].arguments = ['first', 'second'];
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    fs.writeFileSync('RP/asset.json', JSON.stringify({ argv: process.argv.slice(2), bp: fs.readdirSync('BP'), data: fs.readdirSync('data') }));
  `);
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8')), {
    argv: ['first', 'second'], bp: [], data: [],
  });
  await writeFile(path.join(project.project, 'filters/main.cjs'), `require('node:fs').writeFileSync('BP/unmapped.json', '{}');`);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /wrote to BP without a configured pack mapping/);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8')).argv, ['first', 'second']);
});

test('named scripts and native modules see each others staged edits in step order', async (t) => {
  const project = await fixture(t);

  project.config.bedrockCore.plugins.increment = { module: './filters/increment.mjs' };
  project.config.bedrockCore.profiles.default.steps = [
    { plugin: 'example', after: 'prepare', settings: { value: 3 } },
    { plugin: 'increment', after: 'prepare', settings: { amount: 4 } },
    { plugin: 'example', before: 'export', settings: { factor: 2 } },
  ];
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const settings = JSON.parse(process.argv[2]);
    const value = settings.value ?? JSON.parse(fs.readFileSync('RP/asset.json', 'utf8')).value * settings.factor;
    fs.writeFileSync('RP/asset.json', JSON.stringify({ value }));
  `);
  await writeFile(path.join(project.project, 'filters/increment.mjs'), `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      const file = path.join(context.packs.visuals, 'asset.json');
      const document = JSON.parse(await fs.readFile(file, 'utf8'));
      document.value += settings.amount;
      await fs.writeFile(file, JSON.stringify(document));
    }
  `);
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8')), { value: 14 });
  assert.equal(await readFile(path.join(project.project, 'packs/visuals/asset.json'), 'utf8'), '{"value":1}');
});

test('explicit BP and RP mappings select a pair in a multi-pack project', async (t) => {
  const project = await fixture(t);

  await mkdir(path.join(project.project, 'packs/extra'));
  await writeFile(path.join(project.project, 'packs/extra/manifest.json'), JSON.stringify(manifestFor('data')));
  await writeFile(path.join(project.project, 'packs/extra/keep.json'), '{"keep":true}');
  project.config.packs.extra = './packs/extra';
  project.config.bedrockCore.profiles.default.export.extra = './dist/extra';
  await writeFile(path.join(project.project, 'filters/main.cjs'), `require('node:fs').writeFileSync('BP/mapped.json', '{}');`);
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /explicit packs.BP mapping/);
  project.config.bedrockCore.plugins.example.packs = { BP: 'gameplay', RP: 'visuals' };
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(existsSync(path.join(result.outputPaths.gameplay, 'mapped.json')), true);
  assert.equal(existsSync(path.join(result.outputPaths.extra, 'mapped.json')), false);
  assert.equal(await readFile(path.join(result.outputPaths.extra, 'keep.json'), 'utf8'), '{"keep":true}');
});

test('targets run once per matching manifest type with arbitrary names and shared data', async (t) => {
  const project = await fixture(t);

  await addPack(project, 'bp_assets', 'resources');
  await addPack(project, 'rp_logic', 'data');
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const role = fs.existsSync('BP/manifest.json') ? 'BP' : 'RP';
    const opposite = role === 'BP' ? 'RP' : 'BP';
    const visit = fs.existsSync('data/visits.json') ? JSON.parse(fs.readFileSync('data/visits.json', 'utf8')).count + 1 : 1;
    fs.writeFileSync('data/visits.json', JSON.stringify({ count: visit }));
    fs.writeFileSync(role + '/handled.json', JSON.stringify({ id: process.env.PACK_ID, type: process.env.PACK_TYPE, role, visit, opposite: fs.readdirSync(opposite) }));
  `);

  for (const [targets, expected] of [
    ['resource', ['visuals', 'bp_assets']],
    ['behavior', ['gameplay', 'rp_logic']],
    ['both', ['gameplay', 'visuals', 'bp_assets', 'rp_logic']],
  ]) {
    project.config.bedrockCore.plugins.example.targets = targets;
    await project.save();
    const result = await runBuild({ configPath: project.configPath, logger: {} });

    for (const [id, directory] of Object.entries(result.outputPaths)) {
      const file = path.join(directory, 'handled.json');
      const visit = expected.indexOf(id);

      if (visit === -1) {
        assert.equal(existsSync(file), false);
        continue;
      }

      const type = ['gameplay', 'rp_logic'].includes(id) ? 'behavior' : 'resource';

      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        id, type, role: type === 'behavior' ? 'BP' : 'RP', visit: visit + 1, opposite: [],
      });
      assert.equal(existsSync(path.join(project.project, 'packs', id, 'handled.json')), false);
    }

    assert.equal(existsSync(path.join(project.project, 'data/visits.json')), false);
    assert.equal(await readFile(path.join(result.outputPaths.bp_assets, 'asset.json'), 'utf8'), '{"id":"bp_assets"}');
    assert.equal(await readFile(path.join(result.outputPaths.rp_logic, 'asset.json'), 'utf8'), '{"id":"rp_logic"}');
  }
});

test('a failure on a later targeted pack preserves every previous export', async (t) => {
  const project = await fixture(t);

  await addPack(project, 'extra', 'resources');
  project.config.bedrockCore.plugins.example.targets = 'resource';
  await project.save();
  const previous = await runBuild({ configPath: project.configPath, logger: {} });

  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    require('node:fs').writeFileSync('RP/asset.json', '{"changed":true}');
    if (process.env.PACK_ID === 'extra') { process.exit(23); }
  `);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /exit code 23/);
  assert.equal(await readFile(path.join(previous.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":1}');
  assert.equal(await readFile(path.join(previous.outputPaths.extra, 'asset.json'), 'utf8'), '{"id":"extra"}');
  assert.equal(await readFile(path.join(project.project, 'packs/visuals/asset.json'), 'utf8'), '{"value":1}');
  assert.equal(await readFile(path.join(project.project, 'packs/extra/asset.json'), 'utf8'), '{"id":"extra"}');
});

test('a targeted script skips execution when no pack matches', async (t) => {
  const project = await fixture(t);
  const logs = [];

  delete project.config.packs.visuals;
  delete project.config.bedrockCore.profiles.default.export.visuals;
  project.config.bedrockCore.plugins.example.targets = 'resource';
  await writeFile(path.join(project.project, 'filters/main.cjs'), 'throw new Error("filter must not execute");');
  await project.save();
  await runBuild({ configPath: project.configPath, logger: { info: line => logs.push(line) } });
  assert.ok(logs.some(line => line.includes('skipped (No resource packs)')));
});

test('nonzero exits, invalid JSON and symlink outputs preserve authored files and previous exports', async (t) => {
  const project = await fixture(t);
  const options = { configPath: project.configPath, logger: {} };
  const initial = await runBuild(options);
  const output = path.join(initial.outputPaths.visuals, 'asset.json');

  for (const [script, error] of [
    [`require('node:fs').writeFileSync('RP/asset.json', '{"value":2}'); process.exit(23);`, /exit code 23/],
    [`require('node:fs').writeFileSync('RP/asset.json', '{');`, /JSON|parse|syntax/i],
    [`require('node:fs').symlinkSync(process.env.ROOT_DIR, 'RP/linked', process.platform === 'win32' ? 'junction' : 'dir');`, /symlink/],
  ]) {
    await writeFile(path.join(project.project, 'filters/main.cjs'), script);
    await assert.rejects(runBuild(options), error);
    assert.equal(await readFile(output, 'utf8'), '{"value":1}');
    assert.equal(await readFile(path.join(project.project, 'packs/visuals/asset.json'), 'utf8'), '{"value":1}');
  }
});

test('invalid definitions, settings and conflicting data roots fail before filter execution', async (t) => {
  const project = await fixture(t);
  const step = project.config.bedrockCore.profiles.default.steps[0];

  await writeFile(path.join(project.project, 'filters/main.cjs'), 'throw new Error("filter executed");');
  step.settings = 'bad';
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Invalid project configuration/);
  delete step.settings;

  for (const [definition, error] of [
    [{ script: 7 }, /Invalid project configuration/],
    [{ script: './filters/main.cjs', packs: { BP: 'missing' } }, /pack is not configured/],
    [{ script: './filters/main.cjs', packs: { BP: 'gameplay', RP: 'gameplay' } }, /different packs/],
    [{ script: './filters/main.cjs', dataPath: '../outside' }, /dataPath must be inside/],
    [{ script: './filters/main.cjs', dataPath: './missing' }, /dataPath does not exist/],
  ]) {
    project.config.bedrockCore.plugins.example = definition;
    await project.save();
    await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), error);
  }

  await mkdir(path.join(project.project, 'first-data'));
  await mkdir(path.join(project.project, 'second-data'));
  await writeFile(path.join(project.project, 'filters/main.cjs'), '');
  project.config.bedrockCore.plugins.example = { script: './filters/main.cjs', dataPath: './first-data' };
  project.config.bedrockCore.plugins.second = { script: './filters/main.cjs', dataPath: './second-data' };
  project.config.bedrockCore.profiles.default.steps.push({
    plugin: 'second', before: 'export',
  });
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /share the same dataPath/);
});

test('cancellation terminates the filter before temporary workspace cleanup', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const initial = await runBuild({ configPath: project.configPath, logger: {} });
  const cancellation = new AbortController();
  let directory;

  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    console.log('ready:' + process.cwd());
    setInterval(() => require('node:fs').writeFileSync('RP/asset.json', '{"late":true}'), 100);
  `);
  await assert.rejects(runBuild({
    configPath: project.configPath, signal: cancellation.signal,
    logger: { info(line) {
      if (line.startsWith('ready:')) {
        directory = line.slice(6);
        cancellation.abort(new Error('cancelled Node filter'));
      }
    } },
  }), /cancelled Node filter/);
  assert.ok(directory);
  assert.equal(existsSync(directory), false);
  assert.equal(await readFile(path.join(initial.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":1}');
});

test('the local manifest Regolith filter runs unchanged and resolves a manifest variant', { skip: !existsSync(path.join(manifestFilter, 'main.ts')) }, async (t) => {
  const project = await fixture(t);
  const source = path.join(project.project, 'packs/visuals');
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));

  manifest.metadata = { authors: ['Fixture'] };
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(source, 'manifest.test.json'), JSON.stringify({ extends: './manifest.json', header: { name: 'Legacy variant' } }));
  project.config.bedrockCore.plugins.example = { filterDir: manifestFilter, script: './main.ts' };
  project.config.bedrockCore.profiles.default.steps[0].settings = { manifestPath: 'RP/manifest.test.json' };
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const exported = JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'manifest.json'), 'utf8'));

  assert.equal(exported.header.name, 'Legacy variant');
  assert.equal(exported.header.uuid, manifest.header.uuid);
  assert.equal(existsSync(path.join(result.outputPaths.visuals, 'manifest.test.json')), false);
  assert.equal(existsSync(path.join(source, 'manifest.test.json')), true);
  assert.equal(JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')).header.name, manifest.header.name);
});

test('the local Node bundler resolves its installed dependencies and project npm imports', {
  skip: !existsSync(path.join(bundlerFilter, 'main.ts')) || !existsSync(path.join(bundlerFilter, 'node_modules/esbuild/package.json')),
}, async (t) => {
  const project = await fixture(t);
  const dependency = path.join(project.project, 'node_modules/@bedrock-core/legacy-fixture');

  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: '@bedrock-core/legacy-fixture', type: 'module', main: './index.js' }));
  await writeFile(path.join(dependency, 'index.js'), 'export const value = 16;');
  await writeFile(path.join(project.project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'ESNext' } }));
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), `import { value } from '@bedrock-core/legacy-fixture'; export const result: number = value + 1;`);
  project.config.bedrockCore.plugins.example = { filterDir: bundlerFilter, script: './main.ts' };
  project.config.bedrockCore.profiles.default.steps[0].settings = { debug: true };
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const output = path.join(result.outputPaths.gameplay, 'scripts/main.js');
  const runtime = await import(pathToFileURL(output).href);

  assert.equal(runtime.result, 17);
  assert.equal(existsSync(path.join(result.outputPaths.gameplay, 'scripts/main.ts')), false);
  assert.equal(existsSync(path.join(project.project, 'packs/gameplay/scripts/main.ts')), true);
});

test('watch reloads external Node filter helpers without output loops', { timeout: 15000 }, async (t) => {
  const project = await fixture(t, { cleanup: false });
  const filterDir = path.join(project.root, 'external-filter');
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  await mkdir(filterDir);
  await writeFile(path.join(filterDir, 'value.cjs'), 'module.exports = 1;');
  await writeFile(path.join(filterDir, 'main.cjs'), `
    const fs = require('node:fs');
    fs.writeFileSync('RP/asset.json', JSON.stringify({ value: require('./value.cjs'), filter: process.env.FILTER_DIR }));
  `);
  project.config.bedrockCore.plugins.example = { filterDir, script: './main.cjs' };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await project.save();
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });

  const waitFor = async (count) => {
    const deadline = Date.now() + 10000;

    while (results.length < count) {
      assert.ok(Date.now() < deadline, 'watch should rebuild Node filter output: ' + errors.map(String));
      await delay(20);
    }
  };

  await waitFor(1);
  await writeFile(path.join(filterDir, 'value.cjs'), 'module.exports = 7;');
  await waitFor(2);
  assert.deepEqual(JSON.parse(await readFile(path.join(results.at(-1).outputPaths.visuals, 'asset.json'), 'utf8')), { value: 7, filter: filterDir });
  await delay(200);
  assert.equal(results.length, 2);
  assert.deepEqual(errors, []);
});
