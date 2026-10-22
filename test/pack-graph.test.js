import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspectPacks, selectPacks, resolvePackOwner, resolveResourcePack } from '@bedrock-core/builder-plugin';
import { runBuild } from '../src/run.ts';
import { manifestFor } from '../test-support/manifest.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-pack-graph-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests = { gameplay: manifestFor('script'), resources: manifestFor('resources'), extras: manifestFor('resources') };

  manifests.gameplay.dependencies = [
    { uuid: manifests.resources.header.uuid.toUpperCase(), version: '1.0.0' },
    { uuid: '12345678-1234-1234-1234-123456789abc', version: '2.0.0' },
    { module_name: '@minecraft/server', version: '2.10.0' },
  ];
  manifests.resources.dependencies = [{ uuid: manifests.gameplay.header.uuid, version: '1.0.0' }];
  const directories = {};

  for (const [id, manifest] of Object.entries(manifests)) {
    directories[id] = path.join(root, id);
    await mkdir(directories[id]);
    await writeFile(path.join(directories[id], 'manifest.json'), JSON.stringify(manifest));
  }

  await mkdir(path.join(directories.gameplay, 'scripts'));
  await writeFile(path.join(directories.gameplay, 'scripts/main.js'), 'export const loaded = true;');

  return { root, manifests, directories };
}

test('native requirements resolve by header UUID, retain external modules and allow reciprocal packs', async (t) => {
  const { directories, manifests } = await fixture(t);
  const packs = await inspectPacks(directories);

  assert.equal(packs[0].dependencies[0].packId, 'resources');
  assert.deepEqual(packs[0].dependencies.map(dependency => dependency.kind), ['local', 'external', 'module']);
  assert.equal(packs[1].dependencies[0].packId, 'gameplay');
  assert.equal(packs[0].manifest.modules[0].entry, 'scripts/main.js');
  assert.equal(packs[0].uuid, manifests.gameplay.header.uuid);
  assert.throws(() => {
    packs[0].manifest.modules[0].entry = 'changed';
  }, TypeError);
  assert.equal(resolveResourcePack(packs, resolvePackOwner(packs)).id, 'resources');
});

test('module selectors intersect IDs, select a combined pack once and reject unknown IDs', async (t) => {
  const { directories, manifests } = await fixture(t);

  manifests.gameplay.modules.push(manifestFor('data').modules[0]);
  await writeFile(path.join(directories.gameplay, 'manifest.json'), JSON.stringify(manifests.gameplay));
  const packs = await inspectPacks(directories);

  assert.deepEqual(selectPacks(packs, { modules: ['data', 'script'] }).map(pack => pack.id), ['gameplay']);
  assert.deepEqual(selectPacks(packs, { packs: ['extras'], modules: ['resources'] }).map(pack => pack.id), ['extras']);
  assert.deepEqual(selectPacks(packs, { packs: ['gameplay'], modules: ['resources'] }), []);
  assert.throws(() => selectPacks(packs, { packs: ['missing'] }), /unknown pack/);
});

test('routing diagnoses unrelated, ambiguous and missing resource destinations', async (t) => {
  const { directories, manifests } = await fixture(t);
  let packs = await inspectPacks(directories);

  assert.throws(() => resolveResourcePack(packs, packs[0], 'extras'), /declare a dependency/);
  assert.throws(() => resolveResourcePack(packs, packs[0], 'gameplay'), /declaring resources/);
  manifests.gameplay.dependencies.push({ uuid: manifests.extras.header.uuid, version: '1.0.0' });
  await writeFile(path.join(directories.gameplay, 'manifest.json'), JSON.stringify(manifests.gameplay));
  packs = await inspectPacks(directories);
  assert.throws(() => resolveResourcePack(packs, packs[0]), /resources, extras/);
  assert.equal(resolveResourcePack(packs, packs[0], 'extras').id, 'extras');
  assert.equal(resolveResourcePack(packs, packs[1]).id, 'resources');
  manifests.gameplay.dependencies = [];
  await writeFile(path.join(directories.gameplay, 'manifest.json'), JSON.stringify(manifests.gameplay));
  packs = await inspectPacks(directories);
  assert.throws(() => resolveResourcePack(packs, packs[0]), /candidates: none/);
});

test('local versions use the currently selected manifests', async (t) => {
  const { directories, manifests } = await fixture(t);

  manifests.resources.header.version = '2.0.0';
  await writeFile(path.join(directories.resources, 'manifest.json'), JSON.stringify(manifests.resources));
  await assert.rejects(inspectPacks(directories), /requires 1.0.0.*selected manifest is 2.0.0/);
});

test('targeted invocations retain the full graph and project scope invokes once for several packs', async (t) => {
  const { root, directories } = await fixture(t);

  await writeFile(path.join(root, 'plugin.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export const requirements = { modules: ['data', 'script', 'resources'] };
    export async function run(context, settings) {
      const graph = await context.inspectPacks();
      if (settings.extension) {
        context.registerBundleExtension({ id: 'selected:extension', version: '1' });
        const input = path.join(context.allPacks.resources, 'inputs');
        context.excludeFromExport(input);
        if (!context.inputDirectories.includes(input)) throw new Error('Stale input directory metadata');
      }
      const data = { selected: Object.keys(context.packs), outputs: Object.keys(context.outputPaths), all: Object.keys(context.allPacks), graph: graph.map(pack => pack.id), extensions: context.bundleExtensions.map(extension => extension.packs) };
      await writeFile(path.join(context.allPacks[settings.output ?? context.pack.id], settings.file), JSON.stringify(data));
    }
  `);
  const config = {
    name: 'Graph', authors: [], targetVersion: '1.26.50', namespace: 'graph_test',
    packs: Object.fromEntries(Object.keys(directories).map(id => [id, `./${id}`])),
    bedrockCore: { formatVersion: '1.0.0', plugins: {
      owner: { module: './plugin.ts', packs: ['gameplay'] },
      project: { module: './plugin.ts', packs: ['resources', 'extras'], scope: 'project' },
      each: { module: './plugin.ts', scope: 'pack' },
    }, profiles: { default: {
      stages: { bundler: false },
      steps: [
        { plugin: 'owner', after: 'manifest', settings: { output: 'resources', file: 'owner.json' } },
        { plugin: 'project', after: 'manifest', settings: { output: 'extras', file: 'selected.json', extension: true } },
        { plugin: 'each', after: 'manifest', settings: { file: 'scoped.json' } },
      ],
      export: Object.fromEntries(Object.keys(directories).map(id => [id, `./dist/${id}`])),
    } } },
  };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'dist/resources/owner.json'), 'utf8')), {
    selected: ['gameplay'], outputs: ['gameplay'], all: ['gameplay', 'resources', 'extras'], graph: ['gameplay', 'resources', 'extras'], extensions: [],
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'dist/extras/selected.json'), 'utf8')).selected, ['resources', 'extras']);
  const selected = JSON.parse(await readFile(path.join(root, 'dist/extras/selected.json'), 'utf8'));

  assert.deepEqual(selected.outputs, ['resources', 'extras']);
  assert.deepEqual(selected.extensions, [['resources', 'extras']]);

  for (const id of Object.keys(directories)) {
    const current = JSON.parse(await readFile(path.join(root, `dist/${id}/scoped.json`), 'utf8'));

    assert.deepEqual(current.selected, [id]);
    assert.deepEqual(current.outputs, [id]);
  }
});
