import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { runBuild } from '../src/run.ts';
import { deployPacks, withDeployment } from '../src/deploy.ts';

test('build deployment routes named packs by staged manifests and replaces only their UUID folders', async (t) => {
  const project = await projectFor(t);
  const root = path.join(project.root, 'minecraft');

  project.config.bedrockCore.profiles.default.deploy = { path: root };
  await mkdir(path.join(root, 'development_behavior_packs/unrelated'), { recursive: true });
  await writeFile(path.join(root, 'development_behavior_packs/unrelated/keep'), 'keep');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const destinations = Object.fromEntries(result.deployments.map(pack => [pack.id, pack.path]));

  assert.equal(destinations.gameplay, path.join(root, 'development_behavior_packs', project.behavior.header.uuid));
  assert.equal(destinations.visuals, path.join(root, 'development_resource_packs', project.resources.header.uuid));
  assert.match(await readFile(path.join(destinations.gameplay, 'scripts/main.js'), 'utf8'), /value = 1/);
  await writeFile(path.join(destinations.gameplay, 'stale.json'), '{}');
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 2;');
  await runBuild({ configPath: project.configPath, logger: {} });
  await assert.rejects(readFile(path.join(destinations.gameplay, 'stale.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'development_behavior_packs/unrelated/keep'), 'utf8'), 'keep');
  assert.match(await readFile(path.join(destinations.gameplay, 'scripts/main.js'), 'utf8'), /value = 2/);
});

test('deployment rollback restores every pack if local publication fails', async (t) => {
  const project = await projectFor(t);
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const packs = Object.fromEntries(result.packs.map(pack => [pack.id, pack.path]));
  const root = path.join(project.root, 'minecraft');
  const first = await deployPacks({ packs, root });

  for (const pack of first) {
    await writeFile(path.join(pack.path, 'previous'), 'previous');
  }

  await assert.rejects(withDeployment({ packs, root }, async () => {
    throw new Error('local publication failed');
  }), /local publication failed/);

  for (const pack of first) {
    assert.equal(await readFile(path.join(pack.path, 'previous'), 'utf8'), 'previous');
  }

  assert.deepEqual((await readdir(root)).sort(), ['development_behavior_packs', 'development_resource_packs']);
});

test('destination conflicts, locks and cancellation preserve local and deployed outputs', async (t) => {
  const project = await projectFor(t);
  const root = path.join(project.root, 'minecraft');

  project.config.bedrockCore.profiles.default.deploy = { path: root };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const output = path.join(result.outputPath, 'gameplay/scripts/main.js');
  const previous = await readFile(output, 'utf8');
  const gameplay = result.deployments.find(pack => pack.id === 'gameplay').path;
  const resources = result.deployments.find(pack => pack.id === 'visuals').path;

  await writeFile(path.join(resources, 'manifest.json'), JSON.stringify(manifestFor('resources')));
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 3;');
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /different pack/);
  assert.equal(await readFile(output, 'utf8'), previous);
  assert.equal(await readFile(path.join(gameplay, 'scripts/main.js'), 'utf8'), previous);

  await mkdir(path.join(root, '.bedrock-core-builder-lock'));
  const packs = Object.fromEntries(result.packs.map(pack => [pack.id, pack.path]));

  await assert.rejects(deployPacks({ packs, root }), { code: 'EEXIST' });
  await assert.rejects(deployPacks({ packs, root, signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  assert.equal(await readFile(output, 'utf8'), previous);
});

test('deployment refuses source overlap and unclassified pack types', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');

  await assert.rejects(deployPacks({ packs: { visuals: source }, root: source }), /separate directories/);
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifestFor('world_template')));
  await assert.rejects(deployPacks({ packs: { visuals: source }, root: path.join(project.root, 'minecraft') }), /no development deployment destination/);
});
