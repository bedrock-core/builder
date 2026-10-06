import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { runBuild } from '../src/run.ts';
import { exportPacks, resolveExportPaths } from '../src/export.ts';
import { validateConfig } from '../src/config.ts';

test('each pack exports directly to its own relative or absolute path and leaves siblings intact', async (t) => {
  const project = await projectFor(t);
  const minecraft = path.join(project.root, 'minecraft');
  const paths = {
    gameplay: path.join(minecraft, 'development_behavior_packs/my-addon'),
    visuals: './assets-output',
  };

  project.config.bedrockCore.profiles.default.export = paths;
  await mkdir(path.join(minecraft, 'development_behavior_packs/unrelated'), { recursive: true });
  await writeFile(path.join(minecraft, 'development_behavior_packs/unrelated/keep'), 'keep');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.deepEqual(result.outputPaths, {
    gameplay: paths.gameplay,
    visuals: path.join(project.project, 'assets-output'),
  });
  assert.deepEqual(result.packs.map(pack => pack.path), Object.values(result.outputPaths));
  assert.match(await readFile(path.join(paths.gameplay, 'scripts/main.js'), 'utf8'), /value = 1/);
  assert.equal(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":1}');
  assert.deepEqual((await readdir(paths.gameplay)).sort(), ['manifest.json', 'scripts']);
  await writeFile(path.join(paths.gameplay, 'stale.json'), '{}');
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 2;');
  await runBuild({ configPath: project.configPath, logger: {} });
  await assert.rejects(readFile(path.join(paths.gameplay, 'stale.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(minecraft, 'development_behavior_packs/unrelated/keep'), 'utf8'), 'keep');
  assert.match(await readFile(path.join(paths.gameplay, 'scripts/main.js'), 'utf8'), /value = 2/);
});

test('cancellation after one replacement rolls every pack back and removes owned temporary folders', async (t) => {
  const project = await projectFor(t);
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const packs = Object.fromEntries(result.packs.map(pack => [pack.id, pack.path]));
  const paths = {
    gameplay: path.join(project.root, 'external/BP'),
    visuals: path.join(project.root, 'other/RP'),
  };

  await exportPacks({ packs, paths });

  for (const directory of Object.values(paths)) {
    await writeFile(path.join(directory, 'previous'), 'previous');
  }

  const cancellation = new AbortController();
  const check = cancellation.signal.throwIfAborted.bind(cancellation.signal);

  t.mock.method(cancellation.signal, 'throwIfAborted', () => {
    // The first replacement removes its stale file; cancel while the next destination is pending.
    if (!existsSync(path.join(paths.gameplay, 'previous'))) {
      cancellation.abort(new Error('cancelled between exports'));
    }

    check();
  });

  await assert.rejects(exportPacks({ packs, paths, signal: cancellation.signal }), /cancelled between exports/);

  for (const directory of Object.values(paths)) {
    assert.equal(await readFile(path.join(directory, 'previous'), 'utf8'), 'previous');
    assert.equal((await readdir(path.dirname(directory))).some(name => name.includes('.builder-')), false);
  }
});

test('destination conflicts prevent replacing any pack and locks preserve existing outputs', async (t) => {
  const project = await projectFor(t);
  const options = { configPath: project.configPath, logger: {} };
  const result = await runBuild(options);
  const previous = await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  await writeFile(path.join(result.outputPaths.visuals, 'manifest.json'), '{"unrelated":true}');
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 3;');
  await assert.rejects(runBuild(options), /does not identify a pack/);
  assert.equal(await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), previous);
  const lock = `${result.outputPaths.visuals}.builder-lock`;

  await mkdir(lock);
  await assert.rejects(runBuild(options), { code: 'EEXIST' });
  assert.equal((await readdir(path.dirname(result.outputPaths.gameplay))).includes('gameplay.builder-lock'), false);
  assert.deepEqual(await readdir(lock), []);
  await assert.rejects(runBuild({ ...options, signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('explicit destinations export non-behavior/resource pack types without inferred routing', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');

  await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifestFor('world_template')));
  const destination = path.join(project.root, 'world-template');

  await exportPacks({ packs: { template: source }, paths: { template: destination } });
  assert.equal(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).modules[0].type, 'world_template');
});

test('unknown or missing pack destinations fail before executing plugins', async (t) => {
  const project = await projectFor(t);

  await writeFile(path.join(project.project, 'plugin.ts'), 'throw new Error("plugin loaded");');
  project.config.bedrockCore.plugins = { unsafe: { module: './plugin.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'unsafe', after: 'prepare' }];
  project.config.bedrockCore.profiles.default.export = { gameplay: './dist/gameplay' };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /missing for pack: visuals/);
  project.config.bedrockCore.profiles.default.export.visuals = './dist/visuals';
  project.config.bedrockCore.profiles.default.export.unknown = './dist/unknown';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /not configured: unknown/);
});

test('destinations cannot overlap each other, pack sources or the project root', async (t) => {
  const project = await projectFor(t);

  for (const paths of [
    { gameplay: './same', visuals: './same' },
    { gameplay: './output', visuals: './output/nested' },
    { gameplay: './packs/gameplay', visuals: './RP' },
    { gameplay: './packs', visuals: './RP' },
    { gameplay: '.', visuals: '../RP' },
    { gameplay: '../', visuals: './RP' },
    { gameplay: './.bedrock-core/output', visuals: './RP' },
  ]) {
    assert.throws(() => resolveExportPaths(project.project, project.config.packs, paths), /dedicated pack directory|separate directories/);
  }

  const source = path.join(project.project, 'packs/visuals');

  await assert.rejects(exportPacks({ packs: { visuals: source }, paths: { visuals: path.join(source, 'nested/output') } }), /separate directories/);
  await assert.rejects(readdir(path.join(source, 'nested')), { code: 'ENOENT' });
  assert.throws(() => resolveExportPaths(project.project, project.config.packs, {
    gameplay: './output', visuals: './output.builder-lock',
  }), /reserved .builder- names/);
});

test('Windows export paths exclude existing outputs regardless of directory letter case', { skip: process.platform !== 'win32' }, async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.export.gameplay = './DIST/GAMEPLAY';
  await writeFile(project.configPath, JSON.stringify(project.config));
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const result = await runBuild(options);

  assert.equal(result.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  assert.match(await readFile(path.join(project.project, 'dist/gameplay/scripts/main.js'), 'utf8'), /value = 1/);
});

test('symlink destination parents are refused without changing their targets', async (t) => {
  const project = await projectFor(t);
  const target = path.join(project.root, 'target');
  const link = path.join(project.project, 'linked');

  await mkdir(target);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(link, { force: true, recursive: true }));
  await assert.rejects(exportPacks({
    packs: { visuals: path.join(project.project, 'packs/visuals') },
    paths: { visuals: path.join(link, 'output') },
  }), /symlink ancestors/);
  assert.deepEqual(await readdir(target), []);
});

test('a nonempty destination without a pack manifest is preserved', async (t) => {
  const project = await projectFor(t);
  const destination = path.join(project.root, 'unrelated');

  await mkdir(destination);
  await writeFile(path.join(destination, 'keep'), 'keep');
  await assert.rejects(exportPacks({
    packs: { visuals: path.join(project.project, 'packs/visuals') },
    paths: { visuals: destination },
  }), /does not identify a pack/);
  assert.equal(await readFile(path.join(destination, 'keep'), 'utf8'), 'keep');
});

test('configuration schema accepts pack path maps and validates destination values', async (t) => {
  const project = await projectFor(t);

  validateConfig(project.config);

  for (const value of [true, 1, {}, '', '  ']) {
    const config = structuredClone(project.config);

    config.bedrockCore.profiles.default.export.gameplay = value;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});
