import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestFor } from '../test-support/manifest.js';
import { validatePackManifests } from '../src/manifest.ts';
import { validateConfig } from '../src/config.ts';
import { transformManifest } from '../src/manifest.ts';
import { projectFor } from '../test-support/project.js';
import { runBuild } from '../src/run.ts';

test('manifest validation rejects invalid identities, versions and unsafe script entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-manifest-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/main.js'), 'export const value = 1;');

  for (const mutate of [
    (manifest) => { manifest.header.uuid = 'invalid'; },
    (manifest) => { manifest.modules[0].uuid = manifest.header.uuid; },
    (manifest) => { manifest.header.version = [1, 0, 0]; },
    (manifest) => { manifest.header.version = '1.01.0'; },
    (manifest) => { manifest.header.version = '1.0.0-01'; },
    (manifest) => { manifest.header.min_engine_version = [1, 26, 50]; },
    (manifest) => { manifest.format_version = 2; },
    (manifest) => { manifest.modules[0].entry = 'scripts/../outside.js'; },
    (manifest) => { manifest.modules[0].language = 'typescript'; },
    (manifest) => { manifest.modules[0].entry = 'scripts/missing.js'; },
  ]) {
    const manifest = manifestFor('script');

    mutate(manifest);
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(validatePackManifests({ gameplay: root }), /Pack gameplay/);
  }

  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifestFor('script')));
  await validatePackManifests({ gameplay: root });
});

test('manifest UUIDs are unique across packs regardless of letter case', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-manifest-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const first = manifestFor('data');
  const second = manifestFor('resources');

  second.modules[0].uuid = first.header.uuid.toUpperCase();
  await mkdir(path.join(root, 'one'));
  await mkdir(path.join(root, 'two'));
  await writeFile(path.join(root, 'one/manifest.json'), JSON.stringify(first));
  await writeFile(path.join(root, 'two/manifest.json'), JSON.stringify(second));
  await assert.rejects(validatePackManifests({ one: path.join(root, 'one'), two: path.join(root, 'two') }), /duplicate manifest UUID/);
});

test('bundler schema accepts options without another entry declaration', () => {
  const config = {
    name: 'Schema fixture', authors: [], targetVersion: '1.26.50',
    namespace: 'test', packs: { gameplay: './BP' },
    bedrockCore: { formatVersion: '1.0.0', profiles: { default: { stages: {
      bundler: { debug: true },
    } } } },
  };

  validateConfig(config);
});

test('manifest transforms preserve module identity and unrelated fields without mutating input', () => {
  const input = manifestFor('script');

  input.metadata = { authors: ['Author'], custom: { retained: true } };
  input.settings = [{ type: 'label', text: 'Settings' }];
  const snapshot = structuredClone(input);
  const output = transformManifest(input, {
    header: { name: 'Test name' },
    metadata: { custom: { added: true } },
    modules: { [input.modules[0].uuid]: { entry: 'scripts/tests.js' } },
  });

  assert.deepEqual(input, snapshot);
  assert.equal(output.modules[0].uuid, input.modules[0].uuid);
  assert.equal(output.modules[0].entry, 'scripts/tests.js');
  assert.deepEqual(output.metadata.custom, { retained: true, added: true });
  assert.deepEqual(output.settings, input.settings);
  assert.throws(() => transformManifest(input, { modules: { missing: {} } }), /unknown UUID/);
});

test('manifest stage selects profile test scripts without modifying authored files', async (t) => {
  const project = await projectFor(t);
  const manifestPath = path.join(project.project, 'packs/gameplay/manifest.json');
  const original = await readFile(manifestPath, 'utf8');
  const result = await runBuild({ configPath: project.configPath, profile: 'tests', logger: {} });

  assert.match(await readFile(path.join(result.outputPaths.gameplay, 'scripts/tests.js'), 'utf8'), /99/);
  assert.equal(await readFile(manifestPath, 'utf8'), original);
  assert.equal(result.artifacts.some(artifact => artifact.id === 'manifest:gameplay'), true);

  project.config.bedrockCore.profiles.tests.stages.manifest.packs.missing = { scriptEntry: 'scripts/tests.js' };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, profile: 'tests', logger: {} }), /unconfigured pack/);
});
