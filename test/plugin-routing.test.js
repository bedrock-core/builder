import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPacks } from '@bedrock-core/builder-plugin';
import { resolvePluginPacks } from '../src/plugin-packs.ts';
import { runBuild } from '../src/run.ts';
import { planBuild } from '../src/plan.ts';
import { validateConfig } from '../src/config.ts';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const requirements = { modules: ['script'], dependencies: { assets: { modules: ['resources'] } } };

async function addPack(project, id, type, dependencies = []) {
  const directory = path.join(project.project, 'packs', id);
  const manifest = manifestFor(type);

  manifest.dependencies = dependencies;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));

  if (type === 'script') {
    await mkdir(path.join(directory, 'scripts'));
    await writeFile(path.join(directory, 'scripts/main.ts'), 'export const loaded = true;');
  }

  project.config.packs[id] = './packs/' + id;
  project.config.bedrockCore.profiles.default.export[id] = './dist/' + id;

  return manifest;
}

async function setup(t, body, options = {}) {
  const project = await projectFor(t);
  const declaration = options.requirements ?? requirements;

  await writeFile(path.join(project.project, 'plugin.mjs'), `
    import { writeFile, appendFile } from 'node:fs/promises';
    import path from 'node:path';
    export const requirements = ${JSON.stringify(declaration)};
    export async function run(context, settings) { ${body} }
  `);
  project.config.bedrockCore.plugins = { custom: { module: './plugin.mjs', ...options.definition } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'custom', after: 'manifest', ...options.step }];

  return project;
}

async function build(project) {
  await writeFile(project.configPath, JSON.stringify(project.config));

  return runBuild({ configPath: project.configPath, logger: {} });
}

test('plugin requirements select every matching owner once and expose named linked destinations', async (t) => {
  const project = await setup(t, `
    const data = { owner: context.pack.id, packs: Object.keys(context.packs), assets: context.linkedPacks.assets.map(pack => pack.id), outputs: Object.keys(context.outputPaths) };
    await writeFile(path.join(context.pack.path, 'routing.json'), JSON.stringify(data));
  `);

  project.behavior.modules.push(manifestFor('data').modules[0]);
  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(project.behavior));
  const otherAssets = await addPack(project, 'other-assets', 'resources');

  await addPack(project, 'other', 'script', [{ uuid: otherAssets.header.uuid, version: '1.0.0' }]);
  const result = await build(project);

  for (const [owner, assets] of [['gameplay', 'visuals'], ['other', 'other-assets']]) {
    assert.deepEqual(await json(path.join(result.outputPaths[owner], 'routing.json')), {
      owner, packs: [owner, assets], assets: [assets], outputs: [owner, assets],
    });
  }

  await assert.rejects(access(path.join(result.outputPaths.visuals, 'routing.json')));
});

test('host pack restrictions validate eligibility and step restrictions replace definition defaults', async (t) => {
  const project = await setup(t, `await writeFile(path.join(context.pack.path, 'selected.json'), '{}');`, {
    definition: { packs: ['gameplay'] }, step: { packs: ['other'] },
  });

  await addPack(project, 'other', 'script', [{ uuid: project.resources.header.uuid, version: '1.0.0' }]);
  const result = await build(project);

  await access(path.join(result.outputPaths.other, 'selected.json'));
  await assert.rejects(access(path.join(result.outputPaths.gameplay, 'selected.json')));
  project.config.bedrockCore.profiles.default.steps[0].packs = ['visuals'];
  await assert.rejects(build(project), /owner visuals must declare.*script/);
  project.config.bedrockCore.profiles.default.steps[0].packs = ['missing'];
  await assert.rejects(build(project), /not a configured pack: missing/);
});

test('ambiguous dependencies fail before any owner runs and an explicit linked override resolves them', async (t) => {
  const project = await setup(t, `
    await writeFile(path.join(context.projectRoot, 'ran.txt'), context.pack.id);
    await writeFile(path.join(context.pack.path, 'selected.json'), JSON.stringify(context.linkedPacks.assets.map(pack => pack.id)));
  `);
  const extras = await addPack(project, 'extra-assets', 'resources');

  await addPack(project, 'other', 'script', [
    { uuid: project.resources.header.uuid, version: '1.0.0' }, { uuid: extras.header.uuid, version: '1.0.0' },
  ]);
  await assert.rejects(build(project), /Pack other.*assets.*exactly one.*visuals, extra-assets.*links.other.assets/);
  await assert.rejects(access(path.join(project.project, 'ran.txt')));
  project.config.bedrockCore.profiles.default.steps[0].links = { other: { assets: 'extra-assets' } };
  const result = await build(project);

  assert.deepEqual(await json(path.join(result.outputPaths.other, 'selected.json')), ['extra-assets']);
});

test('dependency roles support optional and multiple matches without pairing unrelated packs', async (t) => {
  const project = await projectFor(t);
  const directories = { gameplay: path.join(project.project, 'packs/gameplay'), visuals: path.join(project.project, 'packs/visuals') };
  const extras = await addPack(project, 'extra-assets', 'resources');

  directories['extra-assets'] = path.join(project.project, 'packs/extra-assets');
  project.behavior.dependencies.push({ uuid: extras.header.uuid, version: '1.0.0' });
  await writeFile(path.join(directories.gameplay, 'manifest.json'), JSON.stringify(project.behavior));
  const graph = await inspectPacks(directories);
  const declaration = { modules: ['script', 'data'], dependencies: {
    assets: { modules: ['resources'], multiple: true }, tools: { modules: ['world_template'], optional: true },
  } };
  const [invocation] = resolvePluginPacks(graph, declaration);

  assert.deepEqual(invocation.linkedPacks.assets.map(pack => pack.id), ['visuals', 'extra-assets']);
  assert.deepEqual(invocation.linkedPacks.tools, []);
  assert.ok(Object.isFrozen(invocation.linkedPacks.assets));
  assert.deepEqual(resolvePluginPacks(graph, declaration, undefined, { gameplay: { assets: ['extra-assets'] } })[0].linkedPacks.assets.map(pack => pack.id), ['extra-assets']);
  assert.throws(() => resolvePluginPacks(graph, declaration, undefined, { gameplay: { missing: 'visuals' } }), /undeclared plugin dependency/);
  assert.throws(() => resolvePluginPacks(graph, declaration, undefined, { missing: { assets: 'visuals' } }), /unknown or incompatible owner/);
  assert.throws(() => resolvePluginPacks(graph, { modules: [] }), /nonempty modules/);
  assert.throws(() => resolvePluginPacks(graph, { modules: ['script'], dependencies: { bad: { modules: ['resources'], optional: 'yes' } } }), /Invalid plugin dependency/);
});

test('dependency overrides reject unrelated, wrong-type and external destinations', async (t) => {
  const project = await setup(t, '');

  await addPack(project, 'unrelated', 'resources');

  for (const [target, message] of [['unrelated', /must declare a manifest dependency/], ['gameplay', /configured pack declaring resources/], ['external-uuid', /configured pack declaring resources/]]) {
    project.config.bedrockCore.plugins.custom.links = { gameplay: { assets: target } };
    await assert.rejects(build(project), message);
  }
});

test('routing overrides invalidate cache reuse and restore output into the selected dependency only', async (t) => {
  const project = await setup(t, `
    const destination = context.linkedPacks.assets[0];
    const file = path.join(destination.path, 'cached.json');
    await context.reuse('content', { inputs: [], key: '1', async run() {
      await appendFile(path.join(context.projectRoot, 'calls.txt'), 'run|');
      await writeFile(file, JSON.stringify({ destination: destination.id }));
      return { value: null, files: [file] };
    } });
  `);
  const extras = await addPack(project, 'extra-assets', 'resources');

  project.behavior.dependencies.push({ uuid: extras.header.uuid, version: '1.0.0' });
  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(project.behavior));
  project.config.bedrockCore.plugins.custom.links = { gameplay: { assets: 'visuals' } };
  await build(project);
  await build(project);
  assert.equal(await readFile(path.join(project.project, 'calls.txt'), 'utf8'), 'run|');
  project.config.bedrockCore.plugins.custom.links.gameplay.assets = 'extra-assets';
  const result = await build(project);

  assert.deepEqual(await json(path.join(result.outputPaths['extra-assets'], 'cached.json')), { destination: 'extra-assets' });
  await assert.rejects(access(path.join(result.outputPaths.visuals, 'cached.json')));
  assert.equal(await readFile(path.join(project.project, 'calls.txt'), 'utf8'), 'run|run|');
});

test('shared destinations permit separate files and reject overlapping edits from different owners', async (t) => {
  const project = await setup(t, `
    const destination = context.linkedPacks.assets[0];
    await writeFile(path.join(destination.path, settings.shared ? 'shared.json' : context.pack.id + '.json'), JSON.stringify({ owner: context.pack.id }));
  `);

  await addPack(project, 'other', 'script', [{ uuid: project.resources.header.uuid, version: '1.0.0' }]);
  const first = await build(project);

  await access(path.join(first.outputPaths.visuals, 'gameplay.json'));
  await access(path.join(first.outputPaths.visuals, 'other.json'));
  project.config.bedrockCore.profiles.default.steps[0].settings = { shared: true };
  await assert.rejects(build(project), /owners gameplay and other both modify shared pack visuals.shared.json/);
  await access(path.join(first.outputPaths.visuals, 'gameplay.json'));
  await assert.rejects(access(path.join(first.outputPaths.visuals, 'shared.json')));
});

test('project scope aggregates declared owners and related packs into one invocation', async (t) => {
  const project = await setup(t, `
    if (context.pack) throw new Error('Expected project scope');
    await appendFile(path.join(context.projectRoot, 'calls.txt'), 'once');
    await writeFile(path.join(context.packs.gameplay, 'aggregate.json'), JSON.stringify({ packs: Object.keys(context.packs), assets: context.linkedPacks.assets.map(pack => pack.id) }));
  `, { definition: { scope: 'project' } });

  await addPack(project, 'other', 'script', [{ uuid: project.resources.header.uuid, version: '1.0.0' }]);
  const result = await build(project);

  assert.equal(await readFile(path.join(project.project, 'calls.txt'), 'utf8'), 'once');
  assert.deepEqual(await json(path.join(result.outputPaths.gameplay, 'aggregate.json')), { packs: ['gameplay', 'visuals', 'other'], assets: ['visuals'] });
});

test('schema and planner keep native owner overrides separate from legacy script mappings', async () => {
  const base = { name: 'Routing', authors: [], namespace: 'route_test', targetVersion: '1.26.50', packs: { logic: './logic' }, bedrockCore: {
    formatVersion: '1.0.0', plugins: { native: { module: './plugin.mjs', packs: ['logic'] } }, profiles: { default: { export: { logic: './dist/logic' }, steps: [{ plugin: 'native', after: 'prepare', links: { logic: { assets: 'textures' } } }] } },
  } };

  validateConfig(base);
  assert.deepEqual(planBuild(base)[1].links, { logic: { assets: 'textures' } });
  base.bedrockCore.plugins.native = { module: './plugin.mjs', targets: 'both' };
  assert.throws(() => validateConfig(base), /Invalid project/);
  base.bedrockCore.plugins.native = { script: './legacy.js', folders: { BP: 'logic' } };
  validateConfig(base);
  assert.throws(() => planBuild(base), /overrides require a native module/);
});

test('native producers reserve their inputs before automatic generator discovery', async (t) => {
  const project = await setup(t, `await writeFile(path.join(context.pack.path, 'processed.json'), '{}');`, { requirements: { modules: ['script'] }, step: { after: 'generator' } });
  const pluginFile = path.join(project.project, 'plugin.mjs');

  await writeFile(pluginFile, (await readFile(pluginFile, 'utf8')) + `
    export function inputDirectories(context) { return [path.join(context.pack.path, 'custom')]; }
  `);
  await mkdir(path.join(project.project, 'packs/gameplay/custom'));
  await writeFile(path.join(project.project, 'packs/gameplay/custom/model.ts'), 'throw new Error("Must not execute as JSON"); export default {};');
  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  const result = await build(project);

  await access(path.join(result.outputPaths.gameplay, 'processed.json'));
  await assert.rejects(access(path.join(result.outputPaths.gameplay, 'custom/model.json')));
});

test('ineligible owners skip native execution and required missing dependencies fail', async (t) => {
  const project = await setup(t, 'throw new Error("Must not execute");', { requirements: { modules: ['world_template'] } });

  await build(project);
  await writeFile(path.join(project.project, 'plugin.mjs'), `export const requirements = ${JSON.stringify(requirements)}; export function run() { throw new Error('Must not execute'); }`);
  project.behavior.dependencies = [];
  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(project.behavior));
  await assert.rejects(build(project), /assets requires exactly one.*candidates: none/);
});
