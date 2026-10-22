import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runBuild } from '../src/run.ts';
import { runNodeFilter, publishNodeData } from '../src/regolith.ts';
import { observeSourceWrites } from '../src/source-writes.ts';
import { inspectPacks } from '@bedrock-core/builder-plugin';
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
  project.config.bedrockCore.plugins.consume = { script: './filters/consume.mjs', dataPath: './packs/data' };
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
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /explicit folders.BP mapping/);
  project.config.bedrockCore.plugins.example.folders = { BP: 'gameplay', RP: 'visuals' };
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(existsSync(path.join(result.outputPaths.gameplay, 'mapped.json')), true);
  assert.equal(existsSync(path.join(result.outputPaths.extra, 'mapped.json')), false);
  assert.equal(await readFile(path.join(result.outputPaths.extra, 'keep.json'), 'utf8'), '{"keep":true}');
});

test('explicit script steps select one pack set each and share data by source', async (t) => {
  const project = await fixture(t);

  await addPack(project, 'other_assets', 'resources');
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const visit = fs.existsSync('data/visits.json') ? JSON.parse(fs.readFileSync('data/visits.json', 'utf8')).count + 1 : 1;
    fs.writeFileSync('data/visits.json', JSON.stringify({ count: visit }));
    fs.writeFileSync('RP/handled.json', JSON.stringify({ visit, opposite: fs.readdirSync('BP') }));
  `);
  project.config.bedrockCore.profiles.default.steps = ['visuals', 'other_assets'].map(id => ({ plugin: 'example', after: 'prepare', folders: { RP: id } }));
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  for (const [index, id] of ['visuals', 'other_assets'].entries()) {
    assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths[id], 'handled.json'), 'utf8')), { visit: index + 1, opposite: [] });
  }

  assert.equal(existsSync(path.join(result.outputPaths.gameplay, 'handled.json')), false);
  assert.equal(existsSync(path.join(project.project, 'data/visits.json')), false);
});

test('a failure in a later script pack set preserves every previous export', async (t) => {
  const project = await fixture(t);

  await addPack(project, 'extra', 'resources');
  project.config.bedrockCore.profiles.default.steps = ['visuals', 'extra'].map(id => ({ plugin: 'example', after: 'prepare', folders: { RP: id }, settings: { id } }));
  await project.save();
  const previous = await runBuild({ configPath: project.configPath, logger: {} });

  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    require('node:fs').writeFileSync('RP/asset.json', '{"changed":true}');
    if (JSON.parse(process.argv[2]).id === 'extra') process.exit(23);
  `);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /exit code 23/);
  assert.equal(await readFile(path.join(previous.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":1}');
  assert.equal(await readFile(path.join(previous.outputPaths.extra, 'asset.json'), 'utf8'), '{"id":"extra"}');
});

test('folder mappings validate manifest kinds and missing pack IDs before execution', async (t) => {
  const project = await fixture(t);

  await writeFile(path.join(project.project, 'filters/main.cjs'), 'throw new Error("must not execute");');

  for (const [folders, error] of [[{ BP: 'visuals' }, /requires a behavior pack/], [{ RP: 'gameplay' }, /requires a resource pack/], [{ RP: 'missing' }, /pack is not configured/]]) {
    project.config.bedrockCore.plugins.example.folders = folders;
    await project.save();
    await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), error);
  }
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

test('invalid definitions, settings and data paths fail before filter execution', async (t) => {
  const project = await fixture(t);
  const step = project.config.bedrockCore.profiles.default.steps[0];

  await writeFile(path.join(project.project, 'filters/main.cjs'), 'throw new Error("filter executed");');
  step.settings = 'bad';
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Invalid project configuration/);
  delete step.settings;

  for (const [definition, error] of [
    [{ script: 7 }, /Invalid project configuration/],
    [{ script: './filters/main.cjs', folders: { BP: 'missing' } }, /pack is not configured/],
    [{ script: './filters/main.cjs', folders: { BP: 'gameplay', RP: 'gameplay' } }, /requires a resource pack/],
    [{ script: './filters/main.cjs', dataPath: '../outside' }, /dataPath must be a dedicated directory inside/],
    [{ script: './filters/main.cjs', dataPath: './missing' }, /dataPath does not exist/],
  ]) {
    project.config.bedrockCore.plugins.example = definition;
    await project.save();
    await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), error);
  }
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

test('different data sources are isolated while normalized paths share their working copy', async (t) => {
  const project = await fixture(t);

  for (const id of ['first', 'second']) {
    await mkdir(path.join(project.project, id));
    await writeFile(path.join(project.project, id, 'input.json'), JSON.stringify({ id }));
  }

  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const settings = JSON.parse(process.argv[2]);
    const input = JSON.parse(fs.readFileSync('data/input.json', 'utf8'));
    const count = fs.existsSync('data/count.json') ? JSON.parse(fs.readFileSync('data/count.json', 'utf8')).count + 1 : 1;
    fs.writeFileSync('data/count.json', JSON.stringify({ count }));
    fs.writeFileSync('RP/' + settings.output + '.json', JSON.stringify({ id: input.id, count }));
  `);
  project.config.bedrockCore.profiles.default.steps = [
    { plugin: 'example', after: 'prepare', dataPath: './first', settings: { output: 'first' } },
    { plugin: 'example', after: 'prepare', dataPath: './second', settings: { output: 'second' } },
    { plugin: 'example', after: 'prepare', dataPath: './first/../first', settings: { output: 'again' } },
  ];
  await project.save();

  for (let build = 0; build < 2; build++) {
    const result = await runBuild({ configPath: project.configPath, logger: {} });

    for (const [file, id, count] of [['first', 'first', 1], ['second', 'second', 1], ['again', 'first', 2]]) {
      assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, file + '.json'), 'utf8')), { id, count });
    }

    assert.equal(existsSync(path.join(project.project, 'first/count.json')), false);
    assert.equal(existsSync(path.join(project.project, 'second/count.json')), false);
  }
});

test('data-only steps use empty pack folders and reject unbound output', async (t) => {
  const project = await fixture(t);

  project.config.bedrockCore.plugins.example.folders = {};
  project.config.bedrockCore.plugins.consume = { script: './filters/consume.cjs', folders: { RP: 'visuals' } };
  project.config.bedrockCore.profiles.default.steps.push({ plugin: 'consume', before: 'export' });
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    if (fs.readdirSync('BP').length || fs.readdirSync('RP').length) throw new Error('Unexpected mapped pack');
    fs.writeFileSync('data/intermediate.json', '{"generated":true}');
  `);
  await writeFile(path.join(project.project, 'filters/consume.cjs'), `require('node:fs').copyFileSync('data/intermediate.json', 'RP/generated.json');`);
  await project.save();
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'generated.json'), 'utf8')), { generated: true });
  await writeFile(path.join(project.project, 'filters/main.cjs'), `require('node:fs').writeFileSync('BP/unbound.json', '{}');`);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /without a configured pack mapping/);
});

async function persistentFixture(t, options) {
  const project = await fixture(t, options);

  await mkdir(path.join(project.project, 'state'));
  await writeFile(path.join(project.project, 'state/counter.json'), '{"count":1}');
  project.config.bedrockCore.plugins.example.dataPath = './state';
  project.config.bedrockCore.plugins.example.persistData = true;
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const value = JSON.parse(fs.readFileSync('data/counter.json', 'utf8'));
    value.count++;
    fs.writeFileSync('data/counter.json', JSON.stringify(value));
    fs.writeFileSync('RP/counter.json', JSON.stringify(value));
  `);
  await project.save();

  return project;
}

test('opted-in data persists across builds and failed validation leaves source and exports unchanged', async (t) => {
  const project = await persistentFixture(t);
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const source = path.join(project.project, 'state/counter.json');
  const output = path.join(first.outputPaths.visuals, 'counter.json');

  assert.equal(await readFile(source, 'utf8'), '{"count":2}');
  assert.equal(await readFile(output, 'utf8'), '{"count":2}');
  await runBuild({ configPath: project.configPath, logger: {} });
  assert.equal(await readFile(source, 'utf8'), '{"count":3}');
  const script = path.join(project.project, 'filters/main.cjs');

  await writeFile(script, await readFile(script, 'utf8') + `require('node:fs').writeFileSync('RP/invalid.json', '{');`);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /JSON|parse|syntax/i);
  assert.equal(await readFile(source, 'utf8'), '{"count":3}');
  assert.equal(await readFile(output, 'utf8'), '{"count":3}');
  assert.ok(!(await readdir(project.project)).some(name => name.includes('.builder-data-')));
});

test('failed pack publication rolls back every persistent data source', async (t) => {
  const project = await persistentFixture(t);

  await mkdir(path.join(project.project, 'other-state'));
  await writeFile(path.join(project.project, 'other-state/counter.json'), '{"count":10}');
  project.config.bedrockCore.profiles.default.steps.push({ plugin: 'example', before: 'export', dataPath: './other-state', folders: { BP: 'gameplay' }, settings: {} });
  await writeFile(path.join(project.project, 'filters/main.cjs'), `
    const fs = require('node:fs');
    const value = JSON.parse(fs.readFileSync('data/counter.json', 'utf8'));
    value.count++;
    fs.writeFileSync('data/counter.json', JSON.stringify(value));
  `);
  await project.save();
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const destination = path.join(first.outputPaths.visuals, 'manifest.json');

  await writeFile(destination, 'not a manifest');
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Export destination does not identify a pack/);
  assert.equal(await readFile(path.join(project.project, 'state/counter.json'), 'utf8'), '{"count":2}');
  assert.equal(await readFile(path.join(project.project, 'other-state/counter.json'), 'utf8'), '{"count":11}');
  assert.equal(await readFile(destination, 'utf8'), 'not a manifest');
  assert.ok(!(await readdir(project.project)).some(name => name.includes('.builder-data-')));
});

test('persistence detects concurrent source changes and rejects protected or overlapping data roots', async (t) => {
  const project = await persistentFixture(t);
  const source = path.join(project.project, 'state/counter.json');
  const script = path.join(project.project, 'filters/main.cjs');

  await writeFile(script, await readFile(script, 'utf8') + `require('node:fs').writeFileSync(require('node:path').join(process.env.ROOT_DIR, 'state/counter.json'), '{"count":99}');`);
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Node data changed during the build/);
  assert.equal(await readFile(source, 'utf8'), '{"count":99}');
  await writeFile(script, '');
  project.config.bedrockCore.plugins.example.dataPath = './packs/gameplay';
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /dedicated source directory outside packs/);
  project.config.bedrockCore.plugins.example.dataPath = './state';
  await mkdir(path.join(project.project, 'state/nested'));
  project.config.bedrockCore.profiles.default.steps.push({ plugin: 'example', before: 'export', dataPath: './state/nested' });
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Persistent Node data sources must not overlap/);
});

test('cancelling a script preserves persistent data and the previous export', async (t) => {
  const project = await persistentFixture(t);
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const script = path.join(project.project, 'filters/main.cjs');

  await writeFile(script, await readFile(script, 'utf8') + `console.log('ready'); setInterval(() => {}, 1000);`);
  const controller = new AbortController();

  await assert.rejects(runBuild({ configPath: project.configPath, signal: controller.signal, logger: { info(line) {
    if (line === 'ready') {
      controller.abort(new Error('cancelled persistent script'));
    }
  } } }), /cancelled persistent script/);
  assert.equal(await readFile(path.join(project.project, 'state/counter.json'), 'utf8'), '{"count":2}');
  assert.equal(await readFile(path.join(result.outputPaths.visuals, 'counter.json'), 'utf8'), '{"count":2}');
});

test('watch ignores its persistent data publication and rebuilds for authored data edits', { timeout: 15000 }, async (t) => {
  const project = await persistentFixture(t, { cleanup: false });
  const controller = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await project.save();
  const watching = watchBuild({ configPath: project.configPath, signal: controller.signal, logger: {}, onBuild(result) {
    results.push(result);
  }, onError(error) {
    errors.push(error);
  } });

  t.after(async () => {
    controller.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });

  async function waitFor(count) {
    const deadline = Date.now() + 10000;

    while (results.length < count) {
      assert.ok(Date.now() < deadline, errors.map(String).join(', '));
      await delay(20);
    }
  }

  await waitFor(1);
  await delay(400);
  assert.equal(results.length, 1);
  await writeFile(path.join(project.project, 'state/counter.json'), '{"count":10}');
  await waitFor(2);
  await delay(400);
  assert.equal(results.length, 2);
  assert.equal(await readFile(path.join(results.at(-1).outputPaths.visuals, 'counter.json'), 'utf8'), '{"count":11}');
  assert.deepEqual(errors, []);
});

test('data edited during publication remains observable and rollback preserves the edit and backup', async (t) => {
  const project = await persistentFixture(t);
  const staged = path.join(project.root, 'staged');
  const generated = path.join(project.root, 'generated');

  await cp(project.project, staged, { recursive: true });
  await mkdir(generated);
  const packs = { gameplay: path.join(staged, 'packs/gameplay'), visuals: path.join(staged, 'packs/visuals') };
  const context = {
    projectRoot: project.project, stagedRoot: staged, generatedDir: generated, packs,
    outputPaths: { gameplay: path.join(project.root, 'out/gameplay'), visuals: path.join(project.root, 'out/visuals') },
    logger: {}, registerDependency() {},
    async inspectPack(id) { return (await inspectPacks(packs)).find(pack => pack.id === id); },
  };

  await runNodeFilter(context, project.config.bedrockCore.plugins.example);
  const observed = [];
  const stop = observeSourceWrites(project.project, writes => async () => {
    observed.push(...await Promise.all(writes.map(write => write.matches())));
  });

  t.after(stop);
  const source = path.join(project.project, 'state/counter.json');

  await assert.rejects(publishNodeData(context, async () => {
    await writeFile(source, '{"count":99}');
    throw new Error('publication failed');
  }), /Node data rollback failed; backups retained/);
  assert.equal(await readFile(source, 'utf8'), '{"count":99}');
  const backups = (await readdir(project.project)).filter(name => name.startsWith('state.builder-data-backup-'));

  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(project.project, backups[0], 'counter.json'), 'utf8'), '{"count":1}');
  assert.deepEqual(observed, [false]);
});
