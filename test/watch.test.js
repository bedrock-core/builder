import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watchBuild } from '../src/watch.ts';
import { projectFor } from '../test-support/project.js';
import { seedSchemas } from '../test-support/schemas.js';

async function waitFor(condition) {
  const deadline = Date.now() + 10000;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a watch build');
    }

    await delay(20);
  }
}

test('watch rebuilds and deploys real input changes without output loops and recovers after errors', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.deploy = { path: './minecraft' };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();
    await watching;
  });
  await waitFor(() => results.length === 1);
  await delay(200);
  assert.equal(results.length, 1);
  const first = results[0];
  const output = path.join(first.outputPath, 'gameplay/scripts/main.js');
  const source = path.join(project.project, 'packs/gameplay/scripts/main.ts');
  const previous = await readFile(output, 'utf8');

  await writeFile(source, 'invalid TypeScript syntax ?');
  await waitFor(() => errors.length > 0);
  assert.equal(await readFile(output, 'utf8'), previous);
  assert.equal(await readFile(path.join(first.deployments[0].path, 'scripts/main.js'), 'utf8'), previous);
  await writeFile(source, 'export const value = 8;');
  await waitFor(() => results.length > 1);
  assert.match(await readFile(output, 'utf8'), /value = 8/);
  assert.match(await readFile(path.join(first.deployments[0].path, 'scripts/main.js'), 'utf8'), /value = 8/);
  const count = results.length;

  await delay(200);
  assert.equal(results.length, count);
});

test('watch tracks external plugin dependencies and serializes changes arriving during a build', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const cancellation = new AbortController();
  const dependency = path.join(project.root, 'external.json');
  const results = [];
  const errors = [];
  let concurrent = 0;
  let maximumConcurrent = 0;

  await writeFile(dependency, '{"value":1}');
  await writeFile(path.join(project.project, 'dependency.ts'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      context.registerDependency(settings.path);
      await writeFile(path.join(context.packs.visuals, 'dependency.json'), await readFile(settings.path));
    }
  `);
  project.config.bedrockCore.plugins = { dependency: { module: './dependency.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'dependency', after: 'manifest', settings: { path: dependency } }];
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 20 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    validateArtifacts: async () => {
      concurrent++;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await delay(80);
      concurrent--;
    },
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();
    await watching;
  });
  await waitFor(() => results.length === 1);
  await writeFile(dependency, '{"value":2}');
  await waitFor(() => concurrent === 1);
  await mkdir(path.join(project.project, 'new-input'));
  await writeFile(path.join(project.project, 'new-input/file.json'), '{}');
  await waitFor(() => results.length >= 3);
  assert.equal(maximumConcurrent, 1);
  assert.deepEqual(errors, []);
  assert.equal(await readFile(path.join(results.at(-1).outputPath, 'visuals/dependency.json'), 'utf8'), '{"value":2}');
});

test('watch reloads local plugin helpers and recovers from invalid config edits', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const helper = path.join(project.project, 'helper.ts');

  await writeFile(helper, 'export const value = 1;');
  await writeFile(path.join(project.project, 'plugin.ts'), `
    import { value } from './helper.ts';
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      await writeFile(path.join(context.packs.visuals, 'helper.json'), JSON.stringify({ value }));
    }
  `);
  project.config.bedrockCore.plugins = { helper: { module: './plugin.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'helper', after: 'manifest' }];
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();
    await watching;
  });
  await waitFor(() => results.length === 1);
  await writeFile(project.configPath, '{ invalid config');
  await waitFor(() => errors.length > 0);
  await writeFile(helper, 'export const value = 7;');
  await writeFile(project.configPath, JSON.stringify(project.config));
  await waitFor(() => results.length >= 2);
  assert.equal(await readFile(path.join(results.at(-1).outputPath, 'visuals/helper.json'), 'utf8'), '{"value":7}');
});

test('watch reloads generator npm imports and recovers after a template failure', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const dependency = path.join(project.project, 'node_modules/template-data/index.js');
  const template = path.join(project.project, 'packs/visuals/generated.ts');

  await mkdir(path.dirname(dependency), { recursive: true });
  await writeFile(path.join(path.dirname(dependency), 'package.json'), '{"name":"template-data","type":"module","exports":"./index.js"}');
  await writeFile(dependency, 'export const value = 1;');
  await writeFile(template, 'import { value } from "template-data"; export default { value };');
  delete project.config.packs.gameplay;
  project.config.bedrockCore.profiles.default.stages = { generator: { types: false } };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();
    await watching;
  });
  await waitFor(() => results.length === 1);
  const output = path.join(results[0].outputPath, 'visuals/generated.json');

  assert.equal(await readFile(output, 'utf8'), '{"value":1}');
  await writeFile(dependency, 'export const value = 7;');
  await waitFor(() => results.length >= 2);
  assert.equal(await readFile(output, 'utf8'), '{"value":7}');
  await writeFile(template, 'throw new Error("invalid generator"); export default {};');
  await waitFor(() => errors.length > 0);
  assert.equal(await readFile(output, 'utf8'), '{"value":7}');
  await writeFile(template, 'import { value } from "template-data"; export default { value: value * 2 };');
  await waitFor(() => results.length >= 3);
  assert.equal(await readFile(output, 'utf8'), '{"value":14}');
});

test('watch ignores generated editor declarations and still rebuilds authored templates', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const { version } = await seedSchemas(project.project);
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const template = path.join(project.project, 'packs/visuals/generated.ts');
  const declarations = path.join(project.project, 'editor/mc/globals.d.ts');

  delete project.config.packs.gameplay;
  project.config.bedrockCore.profiles.default.stages = { generator: { schemaVersion: version, typesDir: 'editor/mc' } };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(template, 'export default { value: 1 };');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();
    await watching;
  });
  await waitFor(() => results.length === 1);
  const original = await readFile(declarations, 'utf8');

  assert.match(original, /declare type Entity/);
  await writeFile(declarations, `${original}\n// Editor declaration edit.\n`);
  await delay(200);
  assert.equal(results.length, 1);
  await writeFile(template, 'export default { value: 2 };');
  await waitFor(() => results.length >= 2);
  assert.equal(await readFile(path.join(results.at(-1).outputPath, 'visuals/generated.json'), 'utf8'), '{"value":2}');
  await delay(200);
  assert.equal(results.length, 2);
  assert.deepEqual(errors, []);
});
