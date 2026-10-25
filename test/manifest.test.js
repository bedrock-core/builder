import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestFor } from '../test-support/manifest.js';
import { validatePackManifests } from '../src/manifest.ts';
import { validateConfig } from '../src/config.ts';
import { resolveManifest, transformManifest } from '../src/manifest.ts';
import { run as resolveStage } from '@bedrock-core/builder-manifest/plugin';
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

  project.config.bedrockCore.profiles.tests.stages.manifest.manifestPath = './packs/missing/manifest.test.json';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, profile: 'tests', logger: {} }), /configured pack root/);
});

test('manifest inheritance merges objects, replaces arrays and tracks every source without edits', async (t) => {
  const project = await projectFor(t);
  const directory = path.join(project.project, 'packs/gameplay');
  const base = { ...project.behavior, metadata: { authors: ['Author'], custom: { retained: true } }, dependencies: [{ module_name: 'old', version: '1.0.0' }] };
  const sources = {
    'manifest.json': base,
    'manifest.dev.json': { extends: './manifest.json', metadata: { custom: { added: true } }, header: { name: 'Development' } },
    'manifest.test.json': { extends: './manifest.dev.json', metadata: { authors: ['Tester'] }, dependencies: [{ module_name: 'test', version: '2.0.0' }] },
  };

  for (const [file, document] of Object.entries(sources)) {
    await writeFile(path.join(directory, file), JSON.stringify(document));
  }

  const result = await resolveManifest(path.join(directory, 'manifest.test.json'), { root: project.project });

  assert.equal(result.manifest.extends, undefined);
  assert.equal(result.manifest.header.name, 'Development');
  assert.deepEqual(result.manifest.metadata, { authors: ['Tester'], custom: { retained: true, added: true } });
  assert.deepEqual(result.manifest.dependencies, [{ module_name: 'test', version: '2.0.0' }]);
  assert.deepEqual(new Set(result.inputs), new Set(Object.keys(sources).map(file => path.join(directory, file))));

  for (const [file, document] of Object.entries(sources)) {
    assert.equal(await readFile(path.join(directory, file), 'utf8'), JSON.stringify(document));
  }
});

test('manifest sources reject inheritance cycles, missing parents, nonrelative refs and project escapes', async (t) => {
  const project = await projectFor(t);
  const directory = path.join(project.project, 'packs/gameplay');
  const file = path.join(directory, 'manifest.test.json');

  for (const [extendsPath, expected] of [
    ['./manifest.test.json', /Circular extends chain/],
    ['./missing.json', /ENOENT/],
    ['manifest.json', /Invalid extends/],
    ['../../../outside.json', /stay inside the project/],
  ]) {
    await writeFile(file, JSON.stringify({ extends: extendsPath }));
    await assert.rejects(resolveManifest(file, { root: project.project }), expected);
  }
});

test('all configured packs lose staged variants and inherit profile formatting with explicit overrides', async (t) => {
  const project = await projectFor(t);
  const profile = project.config.bedrockCore.profiles.tests;
  const resourceVariant = path.join(project.project, 'packs/visuals/manifest.dev.json');

  await writeFile(resourceVariant, JSON.stringify({ extends: './manifest.json' }));
  profile.pretty = { indent: 'tab' };
  profile.debug = true;
  await writeFile(project.configPath, JSON.stringify(project.config));
  let result = await runBuild({ configPath: project.configPath, profile: 'tests', logger: {} });

  for (const directory of Object.values(result.outputPaths)) {
    assert.equal((await readdir(directory)).some(file => /^manifest\..+\.json$/.test(file)), false);
    assert.match(await readFile(path.join(directory, 'manifest.json'), 'utf8'), /^\{\n\t/);
  }

  assert.ok(result.dependencies.includes(path.join(project.project, 'packs/gameplay/manifest.test.json')));
  assert.ok(result.dependencies.includes(path.join(project.project, 'packs/gameplay/manifest.json')));
  assert.equal(JSON.parse(await readFile(resourceVariant, 'utf8')).extends, './manifest.json');
  assert.ok((await readdir(project.project + '/packs/gameplay')).includes('manifest.test.json'));
  assert.ok((await readdir(result.outputPaths.gameplay + '/scripts')).includes('tests.js.map'));

  profile.stages.manifest.pretty = false;
  profile.stages.bundler = { debug: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  result = await runBuild({ configPath: project.configPath, profile: 'tests', logger: {} });
  assert.doesNotMatch(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'), /\n/);
  assert.equal((await readdir(result.outputPaths.gameplay + '/scripts')).includes('tests.js.map'), false);
});

test('manifest arrays select arbitrary pack roots and reject duplicate selection', async (t) => {
  const project = await projectFor(t);
  const profile = project.config.bedrockCore.profiles.tests;

  await writeFile(path.join(project.project, 'packs/visuals/manifest.test.json'), JSON.stringify({ extends: './manifest.json', header: { name: 'Test assets' } }));
  profile.stages.manifest.manifestPath = ['./packs/gameplay/manifest.test.json', './packs/visuals/manifest.test.json'];
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, profile: 'tests', logger: {} });

  assert.equal(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'manifest.json'), 'utf8')).header.name, 'Test assets');
  profile.stages.manifest.manifestPath.push('./packs/gameplay/manifest.json');
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, profile: 'tests', logger: {} }), /same pack/);
});

test('a failed manifest chain writes and sweeps no pack', async (t) => {
  const project = await projectFor(t);
  const pack = path.join(project.project, 'packs/gameplay');
  const authored = await readFile(path.join(pack, 'manifest.json'), 'utf8');
  const bad = path.join(project.project, 'packs/visuals/manifest.test.json');

  await writeFile(bad, JSON.stringify({ extends: './missing.json' }));
  await assert.rejects(resolveStage({
    stagedRoot: project.project,
    projectRoot: project.project,
    packs: { gameplay: pack, visuals: path.dirname(bad) },
    registerArtifact() { assert.fail('No artifact should be registered'); },
    registerDependency() { assert.fail('No dependency should be registered'); },
  }, { manifestPath: ['packs/gameplay/manifest.test.json', 'packs/visuals/manifest.test.json'] }), /ENOENT/);
  assert.equal(await readFile(path.join(pack, 'manifest.json'), 'utf8'), authored);
  assert.ok((await readdir(pack)).includes('manifest.test.json'));
});

test('manifest inheritance accepts an aliased project root and rejects physical escapes', async (t) => {
  const project = await projectFor(t);
  const alias = path.join(project.root, 'project-alias');
  const outside = path.join(project.root, 'outside');

  await mkdir(outside);
  await writeFile(path.join(outside, 'manifest.json'), JSON.stringify(manifestFor('resources')));
  await symlink(project.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(outside, path.join(project.project, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await resolveManifest(path.join(alias, 'packs/gameplay/manifest.test.json'), { root: alias });

  assert.equal(result.manifest.header.name, 'Test pack');
  assert.equal(result.inputs.length, 2);
  await assert.rejects(resolveManifest(path.join(alias, 'escaped/manifest.json'), { root: alias }), /stay inside the project/);
});
