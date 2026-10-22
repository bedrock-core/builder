import { manifestFor } from '../test-support/manifest.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig } from '../src/config.ts';
import { runBuild } from '../src/run.ts';

const configFor = packs => ({
  name: 'Pack selection', authors: [], targetVersion: '1.26.50',
  namespace: 'pack_test', packs,
  bedrockCore: { formatVersion: '1.0.0', profiles: { default: {
    export: Object.fromEntries(Object.keys(packs).map(id => [id, `./dist/${id}`])),
  } } },
});

test('schema accepts arbitrary pack names and requires named paths', () => {
  for (const packs of [{ resourcePack: './RP' }, { behaviorPack: './BP' }, { resourcePack: './RP', behaviorPack: './BP' }]) {
    validateConfig(configFor(packs));
  }

  validateConfig(configFor({ base: './base', theme: './theme', gameplay: './gameplay', extra: './extra' }));

  for (const packs of [{}, { assets: 42 }]) {
    assert.throws(() => validateConfig(configFor(packs)), /Invalid project configuration/);
  }
});

for (const packId of ['resourcePack', 'behaviorPack']) {
  test(`${packId}-only projects export without a second pack or data directory`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'builder-pack-'));

    t.after(() => rm(root, { recursive: true, force: true }));
    const pack = path.join(root, 'pack');

    await mkdir(pack);
    await writeFile(path.join(pack, 'manifest.json'), JSON.stringify(manifestFor(packId === 'resourcePack' ? 'resources' : 'data')));
    await writeFile(path.join(pack, 'asset.json'), '{}');
    const configPath = path.join(root, 'config.json');

    await writeFile(configPath, JSON.stringify(configFor({ [packId]: './pack' })));
    const result = await runBuild({ configPath, logger: {} });

    assert.deepEqual((await readdir(result.outputPaths[packId])).sort(), ['asset.json', 'manifest.json']);
    assert.equal(await readFile(path.join(result.outputPaths[packId], 'asset.json'), 'utf8'), '{}');
  });
}

test('bundler skips resource packs without requiring a behavior pack', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-pack-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'RP'));
  await writeFile(path.join(root, 'RP/manifest.json'), JSON.stringify(manifestFor('resources')));
  const config = configFor({ resourcePack: './RP' });

  config.bedrockCore.profiles.default.stages = { bundler: true };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });

  assert.equal(result.artifacts.filter(artifact => artifact.owner === 'bundler').length, 0);
});

test('multiple packs use manifest classification rather than configured names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-pack-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const packs = { gameplay: './one', scripts: './two', visuals: './three', theme: './four' };
  const modules = ['data', 'script', 'resources', 'resources'];

  for (const [index, directory] of Object.values(packs).entries()) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, 'manifest.json'), JSON.stringify(manifestFor(modules[index])));
  }

  await mkdir(path.join(root, 'two/scripts'));
  await writeFile(path.join(root, 'two/scripts/main.js'), 'export const existing = 1;');

  const config = configFor(packs);
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });

  assert.deepEqual(result.packs.map(pack => pack.kind), ['behavior', 'behavior', 'resource', 'resource']);
  assert.equal(result.outputPaths.visuals, path.join(root, 'dist/visuals'));
  assert.deepEqual((await readdir(path.join(root, 'dist'))).sort(), Object.keys(packs).sort());

  await rm(path.join(root, 'two/scripts/main.js'));
  await writeFile(path.join(root, 'two/scripts/main.ts'), 'export const value = 1;');
  config.bedrockCore.profiles.default.stages = { bundler: true };
  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  assert.match(await readFile(path.join(root, 'dist/scripts/scripts/main.js'), 'utf8'), /value/);
});

test('final plugin manifest changes are validated before replacing an export', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-manifest-hook-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pack'));
  const authored = JSON.stringify(manifestFor('data'));

  await writeFile(path.join(root, 'pack/manifest.json'), authored);
  const config = configFor({ gameplay: './pack' });
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  const previous = await readFile(path.join(root, 'dist/gameplay/manifest.json'), 'utf8');

  await writeFile(path.join(root, 'modify.ts'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      const file = path.join(context.packs.gameplay, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.header.uuid = settings.uuid;
      await writeFile(file, JSON.stringify(manifest));
    }
  `);
  config.bedrockCore.plugins = { modify: { module: './modify.ts' } };
  const hook = { plugin: 'modify', before: 'export', settings: { uuid: 'invalid' } };

  config.bedrockCore.profiles.default.steps = [hook];
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runBuild({ configPath, logger: {} }), /manifest.header.uuid/);
  assert.equal(await readFile(path.join(root, 'dist/gameplay/manifest.json'), 'utf8'), previous);
  assert.equal(await readFile(path.join(root, 'pack/manifest.json'), 'utf8'), authored);

  hook.settings.uuid = 'abcdefff-1234-1234-1234-123456789abc';
  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  assert.equal(JSON.parse(await readFile(path.join(root, 'dist/gameplay/manifest.json'), 'utf8')).header.uuid, hook.settings.uuid);
});
