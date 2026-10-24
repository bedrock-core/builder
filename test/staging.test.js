import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig } from '../src/config.ts';
import { stagingExclusions, isStagingExcluded } from '../src/staging.ts';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';

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

  project.config.bedrockCore.staging = { exclude: ['.cache', 'build', 'dist'] };
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
