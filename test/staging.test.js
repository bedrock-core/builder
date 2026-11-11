import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig } from '../src/config.ts';
import { stagingExclusions, isStagingExcluded, stagingInputs, isStagingInput } from '../src/staging.ts';
import { runBuild } from '../src/run.ts';
import { projectFor, put } from '../test-support/project.js';

test('staging excludes only literal project paths and protects configuration and pack roots', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.staging = { exclude: ['build', '.cache'] };
  assert.equal(validateConfig(project.config), project.config);
  const excluded = stagingExclusions(project.project, project.config);

  assert.equal(isStagingExcluded(path.join(project.project, 'build/nested/result.json'), excluded), true);
  assert.equal(isStagingExcluded(path.join(project.project, 'build-tools/task.js'), excluded), false);
  assert.equal(isStagingExcluded(path.join(project.project, 'packs/gameplay/build/asset.json'), excluded), false);

  for (const source of ['.', '..', '../outside', '..\\outside', path.resolve(project.project, 'absolute'), 'C:\\absolute', 'C:relative', 'build/**', 'build?', 'config.json', 'packs', 'packs/gameplay']) {
    project.config.bedrockCore.staging.exclude = [source];
    assert.throws(() => stagingExclusions(project.project, project.config), /Staging exclusions/);
  }

  project.config.bedrockCore.staging.exclude = ['build', 'build'];
  assert.throws(() => validateConfig(project.config), /exclude/);
});

test('excluded caches stay outside staging while sibling directories and pack assets remain', async (t) => {
  const project = await projectFor(t);
  const folders = ['.cache', 'build', 'dist', 'build-tools', 'packs/gameplay/build'];

  for (const folder of folders) {
    await mkdir(path.join(project.project, folder), { recursive: true });
    await writeFile(path.join(project.project, folder, 'asset.json'), '{"preserved":true}');
  }

  project.config.bedrockCore.staging = { include: ['build-tools'], exclude: ['.cache', 'build', 'dist'] };
  project.config.bedrockCore.profiles.default.stages.generator = true;
  await writeFile(project.configPath, JSON.stringify(project.config));
  let inspected = false;
  const result = await runBuild({
    configPath: project.configPath, logger: {},
    stages: { async generator(context) {
      for (const folder of ['.cache', 'build', 'dist']) {
        await assert.rejects(access(path.join(context.stagedRoot, folder)), { code: 'ENOENT' });
      }

      await access(path.join(context.stagedRoot, 'build-tools/asset.json'));
      await access(path.join(context.stagedRoot, 'packs/gameplay/build/asset.json'));
      inspected = true;

      return { files: [], reason: 'Inspected staged project' };
    } },
  });

  assert.equal(inspected, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'build/asset.json'), 'utf8')), { preserved: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(project.project, '.cache/asset.json'), 'utf8')), { preserved: true });
});

test('staging includes transitive aliased imports and compiler configs without entering unrelated directories', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'config/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@shared/*":["shared/*"]}}}');
  await put(project.project, 'tsconfig.json', '{"extends":"./config/base.json"}');
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import { value } from "@shared/value"; export { value };');
  await put(project.project, 'shared/value.ts', 'import data from "./data.json"; export const value = data.value;');
  await put(project.project, 'shared/data.json', '{"value":42}');
  await put(project.project, 'shared/unused.ts', 'throw new Error("unrelated module");');
  await put(project.project, 'server/worlds/keep', 'unrelated world');
  await put(project.project, 'archive.zip', 'unrelated archive');
  await symlink(project.root, path.join(project.project, 'server/loop'), process.platform === 'win32' ? 'junction' : 'dir');
  let inspected = false;

  await runBuild({ configPath: project.configPath, logger: {}, validateArtifacts: async (context) => {
    await access(path.join(context.stagedRoot, 'config/base.json'));
    await access(path.join(context.stagedRoot, 'shared/data.json'));
    await assert.rejects(access(path.join(context.stagedRoot, 'shared/unused.ts')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(context.stagedRoot, 'server')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(context.stagedRoot, 'archive.zip')), { code: 'ENOENT' });
    inspected = true;
  } });

  assert.equal(inspected, true);
  assert.equal(await readFile(path.join(project.project, 'server/worlds/keep'), 'utf8'), 'unrelated world');
});

test('nearest pack compiler aliases and explicitly included plugin data participate in staging', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'packs/gameplay/tsconfig.json', '{"compilerOptions":{"baseUrl":"../..","paths":{"@shared/*":["shared/*"]}}}');
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { value } from "@shared/value";');
  await put(project.project, 'shared/value.ts', 'export const value = 7;');
  await put(project.project, 'plugin-data/items.json', '{"item":"example"}');
  project.config.bedrockCore.staging = { include: ['plugin-data'] };
  await writeFile(project.configPath, JSON.stringify(project.config));

  await runBuild({ configPath: project.configPath, logger: {}, validateArtifacts: async (context) => {
    assert.equal(await readFile(path.join(context.stagedRoot, 'plugin-data/items.json'), 'utf8'), '{"item":"example"}');
  } });
});

test('staging include paths are literal and project-relative and exclusions take precedence', async (t) => {
  const project = await projectFor(t);

  for (const include of ['../outside', 'C:\\absolute', 'C:relative', 'data/**', 'data?']) {
    project.config.bedrockCore.staging = { include: [include] };
    await assert.rejects(stagingInputs(project.project, project.config), /Staging inputs/);
  }

  project.config.bedrockCore.staging = { include: ['data'], exclude: ['data/private'] };
  await put(project.project, 'data/public.json', '{}');
  await put(project.project, 'data/private/secret.json', '{}');
  const inputs = await stagingInputs(project.project, project.config);

  assert.equal(isStagingInput(path.join(project.project, 'data/public.json'), inputs), true);
  assert.equal(isStagingExcluded(path.join(project.project, 'data/private/secret.json'), stagingExclusions(project.project, project.config)), true);
});

test('manifest variants retain inherited sources outside pack directories', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'packs/gameplay/manifest.test.json', '{"extends":"../../variants/base.json","header":{"name":"Scoped test pack"}}');
  await put(project.project, 'variants/base.json', '{"extends":"../packs/gameplay/manifest.json"}');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, profile: 'tests', logger: {} });
  const manifest = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert.equal(manifest.header.name, 'Scoped test pack');
});

test('root-like package and compiler paths cannot broaden staging without explicit inclusion', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'package.json', '{"exports":{"./api":"./"}}');
  await put(project.project, 'tsconfig.json', '{"files":["."],"include":"."}');
  await put(project.project, 'server/worlds/keep', 'unrelated');
  const inputs = await stagingInputs(project.project, project.config);

  assert.equal(inputs.includes(project.project), false);
  assert.equal(inputs.every(file => file.startsWith(project.project + path.sep)), true);
  assert.equal(isStagingInput(path.join(project.project, 'server/worlds/keep'), inputs), false);
  project.config.bedrockCore.staging = { include: ['.'] };
  assert.deepEqual(await stagingInputs(project.project, project.config), [project.project]);
});
