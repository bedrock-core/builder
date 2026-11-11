import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectFor, put } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { installUi } from '../test-support/ui.js';
import { installFakeRuntime } from '../test-support/server-runtime.js';
import { runBuild } from '../src/run.ts';
import { bundleScripts } from '../packages/bundler/src/index.ts';
import { moduleNamesFor } from '../packages/bundler/src/compile.ts';
import { bundleUiDeclaration, bundleUiModule, bundleUiLibrary } from '../packages/ui-compiler/src/bundle.ts';
import { readUiDeclaration } from '../packages/ui-compiler/src/declaration.ts';

async function fixture(t, safe = false) {
  const project = await projectFor(t);
  const provider = { ...manifestFor('script'), namespace: 'fixture_provider' };
  const marker = path.join(project.root, 'provider-started');
  const poison = 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "started"); throw new Error("PROVIDER_STARTUP_EXECUTED"); export const value = 42;';

  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'node_modules/peer-addon/package.json', JSON.stringify({
    name: 'peer-addon', type: 'module', version: '1.0.0',
    exports: { '.': { types: './index.d.ts', default: './index.js' }, './manifest.json': './manifest.json', './sub': { types: './sub.d.ts', default: './sub.js' } },
  }));
  await put(project.project, 'node_modules/peer-addon/manifest.json', JSON.stringify(provider));
  await put(project.project, 'node_modules/peer-addon/index.d.ts', 'export interface Contract { value: number }');
  await put(project.project, 'node_modules/peer-addon/index.js', safe ? 'export const value = 42;' : poison);
  await put(project.project, 'node_modules/peer-addon/sub.js', safe ? 'export const value = 42;' : poison);
  await put(project.project, 'node_modules/peer-addon/sub.d.ts', 'export declare function value(): number;');
  project.config.bedrockCore.profiles.default.stages = { 'manifest': true, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false, 'bundler': { debug: true } };

  async function save() {
    await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
    await put(project.project, 'config.json', JSON.stringify(project.config));
  }

  await save();

  return { ...project, marker, save, options: { configPath: project.configPath, logger: {} } };
}

const imports = [
  'import { value } from "peer-addon"; export { value };',
  'import "peer-addon/sub"; export const value = 1;',
  'export { value } from "peer-addon";',
  'export * from "peer-addon/sub";',
  'export const load = () => import("peer-addon/sub");',
  'export const value = require("peer-addon");',
];

test('standalone runtime bundling rejects addon API values before aliases, externals and custom resolvers', async (t) => {
  const project = await fixture(t);
  const entry = path.join(project.project, 'packs/gameplay/scripts/main.ts');
  const options = { root: project.project, entry, outfile: 'standalone.js', moduleNames: ['peer-addon'] };

  for (const source of imports) {
    await writeFile(entry, source);
    await assert.rejects(bundleScripts(options), /External addon API peer-addon/, source);
  }

  await writeFile(entry, imports[0]);
  await put(project.project, 'safe.ts', 'export const value = 1;');
  await assert.rejects(bundleScripts({ ...options, aliases: { 'peer-addon': 'safe.ts' }, external: ['peer-addon'], plugins: [{
    name: 'bypass-attempt', setup(build) {
      build.onResolve({ filter: /peer-addon/ }, () => {
        throw new Error('API resolver was bypassed');
      });
    },
  }] }), /External addon API peer-addon/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('type-only contracts erase while similar-prefix ordinary libraries remain bundled', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'node_modules/peer-addon-extra/package.json', '{"name":"peer-addon-extra","type":"module","exports":"./index.js"}');
  await put(project.project, 'node_modules/peer-addon-extra/index.js', 'export const value = 23;');
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import type { Contract } from "peer-addon"; import { value } from "peer-addon-extra"; export const contract: Contract = { value };');
  const result = await bundleScripts({ root: project.project, entry: 'packs/gameplay/scripts/main.ts', outfile: 'safe.js', moduleNames: ['peer-addon'] });
  const output = await import(pathToFileURL(result.files[0]).href);

  assert.deepEqual(output.contract, { value: 23 });
  assert(!Object.keys(result.metafile.inputs).some(file => file.endsWith('/peer-addon/index.js')));
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

for (const field of ['dependencies', 'optionalDependencies']) {
  test('authored ' + field + ' enforce provider boundaries before runtime bundling', async (t) => {
    const project = await fixture(t);

    (project.behavior[field] ??= []).push({ module_name: 'peer-addon' });
    await put(project.project, 'packs/gameplay/scripts/main.ts', imports[0]);
    await project.save();
    await assert.rejects(runBuild(project.options), /External addon API peer-addon/);
    await assert.rejects(access(project.marker), { code: 'ENOENT' });
  });
}

test('UI declaration and screen bundles stop poison providers before evaluation', async (t) => {
  const project = await fixture(t);

  await installUi(project.project);
  await installFakeRuntime(project.project);
  const entry = await put(project.project, 'packs/gameplay/scripts/main.ts', 'import "peer-addon"; export default () => null;');
  const options = { root: project.project, dependencyRoot: project.project, moduleNames: ['peer-addon'], source: entry };

  await assert.rejects(bundleUiDeclaration(options), /External addon API peer-addon/);
  await assert.rejects(bundleUiModule({ ...options, exports: {} }), /External addon API peer-addon/);
  const runtime = path.join(project.project, 'node_modules/@bedrock-core/ui-runtime/index.js');

  await writeFile(runtime, 'import "peer-addon";\n' + await readFile(runtime, 'utf8'));
  await assert.rejects(bundleUiLibrary(options), /External addon API peer-addon/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('UI capture allows addon API type contracts and preserves the local declaration', async (t) => {
  const project = await fixture(t);

  await installFakeRuntime(project.project);
  const entry = await put(project.project, 'packs/gameplay/scripts/main.ts', 'import type { Contract } from "peer-addon"; import { core } from "@bedrock-core/server-runtime"; const contract: Contract = { value: 9 }; core.register({ manifest: { namespace: "consumer" }, contract });');
  const bundle = await bundleUiDeclaration({ root: project.project, dependencyRoot: project.project, source: entry, moduleNames: ['peer-addon'] });
  const file = await put(project.project, 'declaration.mjs', bundle.code);
  const result = await readUiDeclaration(file);

  assert.equal(result.declaration.manifest.namespace, 'consumer');
  assert.deepEqual(result.declaration.contract, { value: 9 });
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('UI build policy survives the manifest module_name to UUID transformation', async (t) => {
  const project = await fixture(t);

  await installUi(project.project);
  await installFakeRuntime(project.project);
  project.behavior.dependencies.push({ module_name: 'peer-addon' });
  project.config.bedrockCore.profiles.default.stages['ui-compiler'] = true;
  await put(project.project, 'packs/gameplay/scripts/main.ts', imports[1]);
  await project.save();
  await assert.rejects(runBuild(project.options), /External addon API peer-addon/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('pack-scoped APIs and warm cache changes do not affect other addon imports', async (t) => {
  const project = await fixture(t, true);

  await put(project.project, 'packs/gameplay/scripts/main.ts', imports[0]);
  const initial = await runBuild(project.options);
  const warm = await runBuild(project.options);

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  assert((await readFile(path.join(initial.outputPaths.gameplay, 'scripts/main.js'), 'utf8')).includes('42'));
  project.behavior.dependencies.push({ module_name: 'peer-addon' });
  await project.save();
  await assert.rejects(runBuild(project.options), /External addon API peer-addon/);

  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import type { Contract } from "peer-addon"; export const value: Contract = { value: 1 };');
  const other = { ...manifestFor('script', 'scripts/main.ts'), namespace: 'other_addon' };

  project.config.packs.other = './packs/other';
  project.config.bedrockCore.profiles.default.export.other = './dist/other';
  await put(project.project, 'packs/other/manifest.json', JSON.stringify(other));
  await put(project.project, 'packs/other/scripts/main.ts', imports[0]);
  await project.save();
  const scoped = await runBuild(project.options);

  assert((await readFile(path.join(scoped.outputPaths.other, 'scripts/main.js'), 'utf8')).includes('42'));
});

test('profile-selected inherited manifest APIs are scoped to the active build', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/manifest.test.json', JSON.stringify({ extends: './manifest.json', dependencies: [{ module_name: 'peer-addon' }], modules: project.behavior.modules.map(module => ({ ...module, entry: 'scripts/tests.ts' })) }));
  await put(project.project, 'packs/gameplay/scripts/tests.ts', imports[0]);
  await runBuild(project.options);
  await assert.rejects(runBuild({ ...project.options, profile: 'tests' }), /External addon API peer-addon/);
  await runBuild(project.options);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

for (const stage of ['generator', 'i18n']) {
  test(stage + ' cannot evaluate provider startup while compiling authored data', async (t) => {
    const project = await fixture(t);

    project.behavior.dependencies.push({ module_name: 'peer-addon' });
    project.config.bedrockCore.profiles.default.stages[stage] = stage === 'generator' ? { types: false } : true;
    await put(project.project, stage === 'generator' ? 'packs/gameplay/data/value.ts' : 'packs/gameplay/i18n/en_US.ts', 'import { value } from "peer-addon"; export default { value };');
    await project.save();
    await assert.rejects(runBuild(project.options), /External addon API peer-addon/);
    await assert.rejects(access(project.marker), { code: 'ENOENT' });
  });
}

test('generator output cache invalidates when its source becomes a declared addon API importer', async (t) => {
  const project = await fixture(t, true);

  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await put(project.project, 'packs/gameplay/data/value.ts', 'import { value } from "peer-addon"; export default { value };');
  await project.save();
  await runBuild(project.options);
  await runBuild(project.options);
  project.behavior.dependencies.push({ module_name: 'peer-addon' });
  await project.save();
  await assert.rejects(runBuild(project.options), /External addon API peer-addon/);
});

test('compiler owner selection respects path boundaries and targeted source ownership', () => {
  const context = {
    projectRoot: '/authored', stagedRoot: '/staged', packs: { one: '/staged/packs/one', two: '/staged/packs/two' },
    bundleExtensions: [{ packs: ['one'], moduleNames: ['peer-addon'] }, { packs: ['two'], moduleNames: ['other-peer'] }],
  };

  assert.deepEqual(moduleNamesFor(context, '/staged/packs/one/source.ts'), ['peer-addon']);
  assert.deepEqual(moduleNamesFor(context, '/authored/packs/two/source.ts'), ['other-peer']);
  assert.deepEqual(moduleNamesFor(context, '/staged/packs/one-extra/source.ts'), []);
  assert.deepEqual(moduleNamesFor({ ...context, pack: { id: 'one' } }, '/staged/shared/locales.ts'), ['peer-addon']);
});

test('declared Minecraft APIs stay native external imports', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { value } from "@minecraft/fixture-api";');
  const result = await bundleScripts({ root: project.project, entry: 'packs/gameplay/scripts/main.ts', outfile: 'native.js', moduleNames: ['@minecraft/fixture-api'] });
  const output = await readFile(result.files[0], 'utf8');

  assert(output.includes('@minecraft/fixture-api'));
  assert.equal(Object.keys(result.metafile.inputs).length, 1);
});
