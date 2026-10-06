import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig } from '../src/config.ts';
import { runBuild } from '../src/run.ts';

const configFor = packs => ({
  type: 'minecraftBedrock', name: 'Pack selection', authors: [], targetVersion: '1.26.50',
  namespace: 'pack_test', worlds: [], packs,
  bedrockCore: { formatVersion: '1.0.0', profiles: { default: { export: { path: './dist' } } } },
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
    await writeFile(path.join(pack, 'manifest.json'), JSON.stringify({ modules: [{ type: packId === 'resourcePack' ? 'resources' : 'data' }] }));
    await writeFile(path.join(pack, 'asset.json'), '{}');
    const configPath = path.join(root, 'config.json');

    await writeFile(configPath, JSON.stringify(configFor({ [packId]: './pack' })));
    const result = await runBuild({ configPath, logger: {} });

    assert.deepEqual((await readdir(result.outputPath)).sort(), ['build.json', packId].sort());
    assert.equal(await readFile(path.join(result.outputPath, packId, 'asset.json'), 'utf8'), '{}');
  });
}

test('a resource-only project reports bundler-specific missing BP', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-pack-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'RP'));
  await writeFile(path.join(root, 'RP/manifest.json'), JSON.stringify({ modules: [{ type: 'resources' }] }));
  const config = configFor({ resourcePack: './RP' });

  config.bedrockCore.profiles.default.stages = { bundler: { entry: './main.ts' } };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runBuild({ configPath, logger: {} }), /bundler requires a behavior pack/);
});

test('multiple packs use manifest classification rather than configured names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-pack-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const packs = { gameplay: './one', scripts: './two', visuals: './three', theme: './four' };
  const modules = ['data', 'script', 'resources', 'resources'];

  for (const [index, directory] of Object.values(packs).entries()) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, 'manifest.json'), JSON.stringify({ modules: [{ type: modules[index] }] }));
  }

  const config = configFor(packs);
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });

  assert.deepEqual(result.packs.map(pack => pack.kind), ['behavior', 'behavior', 'resource', 'resource']);
  assert.equal(result.packs[2].defaultDeploymentFolder, 'development_resource_packs');
  assert.deepEqual((await readdir(result.outputPath)).sort(), ['build.json', ...Object.keys(packs)].sort());

  await writeFile(path.join(root, 'main.ts'), 'export const value = 1;');
  config.bedrockCore.profiles.default.stages = { bundler: { entry: './main.ts' } };
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runBuild({ configPath, logger: {} }), /set bundler.pack/);
  config.bedrockCore.profiles.default.stages.bundler.pack = 'scripts';
  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  assert.match(await readFile(path.join(root, 'dist/scripts/scripts/main.js'), 'utf8'), /value/);
});
