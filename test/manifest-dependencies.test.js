import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProjectManifests } from '@bedrock-core/builder-manifest';
import { manifestFor } from '../test-support/manifest.js';
import { projectFor, put } from '../test-support/project.js';
import { runBuild } from '../src/run.ts';

const metadata = { name: 'Dependency fixtures', description: '', authors: [], targetVersion: '1.26.50' };

test('namespace references select scripted addons and UUID references select native resource packs', () => {
  const owner = { ...manifestFor('script'), namespace: 'fixture_owner' };
  const library = { ...manifestFor('script'), namespace: 'fixture_library' };
  const resource = { ...manifestFor('resources'), namespace: library.namespace };

  owner.dependencies = [{ namespace: library.namespace }, { uuid: resource.header.uuid }];
  const result = resolveProjectManifests({ consumerRoute: owner, scriptRoute: library, resourceRoute: resource }, metadata);

  assert.deepEqual(result.consumerRoute.dependencies, [
    { namespace: library.namespace, uuid: library.header.uuid, version: library.header.version },
    { uuid: resource.header.uuid, version: resource.header.version },
  ]);
  assert.deepEqual(owner.dependencies[0], { namespace: library.namespace });
  const nativeOnly = resolveProjectManifests({
    consumerRoute: { ...owner, dependencies: [{ uuid: library.header.uuid }], optionalDependencies: [{ uuid: library.header.uuid }] },
    scriptRoute: library,
    resourceRoute: resource,
  }, metadata);

  assert.deepEqual(nativeOnly.consumerRoute.dependencies, [{ uuid: library.header.uuid, version: library.header.version }]);
  assert.deepEqual(nativeOnly.consumerRoute.optionalDependencies, [{ uuid: library.header.uuid, version: library.header.version }]);
  const resourceOnly = resolveProjectManifests({ owner: { ...owner, dependencies: [{ namespace: resource.namespace }] }, resource }, metadata);

  assert.deepEqual(resourceOnly.owner.dependencies, [{ uuid: resource.header.uuid, version: resource.header.version }]);
  const explicitResource = resolveProjectManifests({ owner: { ...owner, dependencies: [{ namespace: library.namespace, uuid: resource.header.uuid }] }, library, resource }, metadata);

  assert.deepEqual(explicitResource.owner.dependencies, [{ uuid: resource.header.uuid, version: resource.header.version }]);

  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.throws(() => resolveProjectManifests({ owner: { ...owner, [field]: [{ pack: 'scriptRoute' }] }, scriptRoute: library }, metadata), /invalid dependency.pack/);
    assert.throws(() => resolveProjectManifests({ owner: { ...owner, [field]: [{ module: '@minecraft/server', version: '2.10.0' }] }, scriptRoute: library, resourceRoute: resource }, metadata), /invalid dependency.module/);
  }
});

test('a shared BP/RP namespace resolves reciprocal native requirements without a Core self-dependency', () => {
  for (const type of ['script', 'data']) {
    const behavior = { ...manifestFor(type), namespace: 'fixture_pair' };
    const resource = { ...manifestFor('resources'), namespace: behavior.namespace };

    behavior.dependencies = [{ namespace: behavior.namespace }];
    resource.dependencies = [{ namespace: behavior.namespace }];
    const result = resolveProjectManifests({ behavior, resource }, metadata);

    assert.deepEqual(result.behavior.dependencies, [{ uuid: resource.header.uuid, version: resource.header.version }]);
    assert.deepEqual(result.resource.dependencies, [{ uuid: behavior.header.uuid, version: behavior.header.version }]);
    assert.deepEqual(behavior.dependencies, [{ namespace: behavior.namespace }]);
    const optional = resolveProjectManifests({ behavior: { ...behavior, dependencies: [], optionalDependencies: behavior.dependencies }, resource }, metadata);

    assert.deepEqual(optional.behavior.optionalDependencies, result.behavior.dependencies);
  }
});

test('behavior namespaces are unique for script and data modules; ambiguous resource references fail', () => {
  for (const types of [['script', 'script'], ['script', 'data'], ['data', 'data']]) {
    const first = { ...manifestFor(types[0]), namespace: 'fixture_duplicate' };
    const second = { ...manifestFor(types[1]), namespace: first.namespace };

    assert.throws(() => resolveProjectManifests({ first, second }, metadata), /Duplicate addon namespace/);
  }

  const behavior = { ...manifestFor('script'), namespace: 'fixture_pair', dependencies: [{ namespace: 'fixture_pair' }] };
  const first = { ...manifestFor('resources'), namespace: behavior.namespace };
  const second = { ...manifestFor('resources'), namespace: behavior.namespace };

  assert.throws(() => resolveProjectManifests({ behavior, first, second }, metadata), /multiple resource packs/);
  const result = resolveProjectManifests({ behavior: { ...behavior, dependencies: [{ namespace: behavior.namespace, uuid: second.header.uuid }] }, first, second }, metadata);

  assert.deepEqual(result.behavior.dependencies, [{ uuid: second.header.uuid, version: second.header.version }]);
  assert.throws(() => resolveProjectManifests({ behavior }, metadata), /own addon namespace/);
});

test('resource and data packs retain only native requirements on external scripted packs', () => {
  const provider = { ...manifestFor('script'), namespace: 'fixture_pair' };

  for (const type of ['resources', 'data']) {
    const owner = { ...manifestFor(type), namespace: provider.namespace };

    owner.dependencies = [{ namespace: provider.namespace, uuid: provider.header.uuid, version: provider.header.version }];
    owner.optionalDependencies = owner.dependencies;
    const result = resolveProjectManifests({ owner }, metadata);

    assert.deepEqual(result.owner.dependencies, [{ uuid: provider.header.uuid, version: provider.header.version }]);
    assert.deepEqual(result.owner.optionalDependencies, result.owner.dependencies);
  }
});

test('paired namespace imports stay native and follow resource versions on warm builds', async (t) => {
  const project = await projectFor(t);

  project.resources.namespace = project.behavior.namespace;
  project.behavior.dependencies = [{ namespace: project.behavior.namespace }];
  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
  await put(project.project, 'packs/visuals/manifest.json', JSON.stringify(project.resources));
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import manifest from "../manifest.json"; export { manifest };');
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const imported = await import(pathToFileURL(path.join(first.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.deepEqual(imported.manifest.dependencies, [{ uuid: project.resources.header.uuid, version: project.resources.header.version }]);
  project.resources.header.version = '1.1.0';
  project.resources.modules[0].version = '1.1.0';
  await put(project.project, 'packs/visuals/manifest.json', JSON.stringify(project.resources));
  const second = await runBuild({ configPath: project.configPath, logger: {} });
  const updated = await import(pathToFileURL(path.join(second.outputPaths.gameplay, 'scripts/main.js')).href + '?paired-update');
  const native = JSON.parse(await readFile(path.join(second.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert.deepEqual(updated.manifest.dependencies, [{ uuid: project.resources.header.uuid, version: '1.1.0' }]);
  assert.deepEqual(native.dependencies, updated.manifest.dependencies);
});

test('installed module metadata resolves aliases and Minecraft beta versions without executing package code', async (t) => {
  const project = await projectFor(t);
  const packageFile = await put(project.project, 'node_modules/api-alias/package.json', JSON.stringify({
    name: '@minecraft/server-gametest', version: '1.0.0-beta.1.26.50-stable', exports: { '.': './index.js' },
  }));

  await put(project.project, 'node_modules/api-alias/index.js', 'throw new Error("Module code must not execute");');
  const inputs = new Set();
  const owner = { ...project.behavior, dependencies: [{ module_name: 'api-alias' }], optionalDependencies: [{ module_name: 'api-alias', version: '3.0.0-beta' }] };
  const result = resolveProjectManifests({ owner }, metadata, { dependencyRoot: project.project, registerDependency: file => inputs.add(file) });

  assert.deepEqual(result.owner.dependencies, [{ module_name: '@minecraft/server-gametest', version: '1.0.0-beta' }]);
  assert.deepEqual(result.owner.optionalDependencies, [{ module_name: '@minecraft/server-gametest', version: '3.0.0-beta' }]);
  assert(inputs.has(packageFile));
  assert.deepEqual(owner.dependencies, [{ module_name: 'api-alias' }]);
  const explicit = resolveProjectManifests({ owner: { ...owner, dependencies: [{ module_name: '@minecraft/server-ui', version: '2.2.0' }], optionalDependencies: [] } }, metadata);

  assert.deepEqual(explicit.owner.dependencies, [{ module_name: '@minecraft/server-ui', version: '2.2.0' }]);
});

test('linked addon packages resolve their exported BP and track package, manifest and inheritance inputs', async (t) => {
  const project = await projectFor(t);
  const linked = path.join(project.root, 'linked-api');
  const actual = await put(linked, 'package.json', JSON.stringify({
    name: '@custom/addon', version: '2.0.0', exports: { './manifest.json': './packs/BP/manifest.json', '.': './packs/BP/scripts/api.js' },
  }));
  const behavior = { ...manifestFor('script'), namespace: 'fixture_linked' };
  const resource = { ...manifestFor('resources'), namespace: behavior.namespace };

  behavior.header.version = '1.4.0';
  const base = await put(linked, 'packs/BP/manifest.base.json', JSON.stringify(behavior));
  const manifest = await put(linked, 'packs/BP/manifest.json', JSON.stringify({ extends: './manifest.base.json', header: { description: 'Linked addon' } }));

  await put(linked, 'packs/RP/manifest.json', JSON.stringify(resource));
  await put(linked, 'packs/BP/scripts/api.js', 'throw new Error("Addon entry must not execute");');

  await put(project.project, 'node_modules/placeholder', '');
  await symlink(linked, path.join(project.project, 'node_modules/api-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const inputs = new Set();
  const result = resolveProjectManifests({ owner: { ...project.behavior, dependencies: [{ module_name: 'api-link' }] } }, metadata, {
    dependencyRoot: project.project, registerDependency: file => inputs.add(file),
  });

  assert.deepEqual(result.owner.dependencies, [{ uuid: behavior.header.uuid, version: behavior.header.version, namespace: behavior.namespace }]);
  assert.notEqual(result.owner.dependencies[0].uuid, resource.header.uuid);
  assert(inputs.has(path.join(project.project, 'node_modules/api-link/package.json')));
  assert(inputs.has(actual));
  assert(inputs.has(path.join(project.project, 'node_modules/api-link/packs/BP/manifest.json')));
  assert(inputs.has(manifest));
  assert(inputs.has(base));
  const explicit = resolveProjectManifests({ owner: { ...project.behavior, dependencies: [{ module_name: 'api-link', version: '1.5.0', namespace: behavior.namespace }] } }, metadata, { dependencyRoot: project.project });

  assert.equal(explicit.owner.dependencies[0].version, '1.5.0');
  assert.throws(() => resolveProjectManifests({ owner: { ...project.behavior, dependencies: [{ module_name: 'api-link', namespace: 'wrong_namespace' }] } }, metadata, { dependencyRoot: project.project }), /requested scripted Core namespace/);
});

test('module package updates refresh bundled manifest imports and native versions on warm builds', async (t) => {
  const project = await projectFor(t);
  const packageFile = await put(project.project, 'node_modules/@minecraft/server/package.json', JSON.stringify({ name: '@minecraft/server', version: '2.10.0' }));

  project.behavior.dependencies.push({ module_name: '@minecraft/server' });
  project.behavior.optionalDependencies = [{ module_name: '@minecraft/server-admin', version: '1.0.0-beta' }];
  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import manifest from "../manifest.json"; export { manifest };');
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const initial = await import(pathToFileURL(path.join(first.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.deepEqual(initial.manifest.dependencies[1], { module_name: '@minecraft/server', version: '2.10.0' });
  assert(first.dependencies.includes(packageFile));
  await put(project.project, 'node_modules/@minecraft/server/package.json', JSON.stringify({ name: '@minecraft/server', version: '2.11.0-beta.1.26.60-preview.22' }));
  const second = await runBuild({ configPath: project.configPath, logger: {} });
  const updated = await import(pathToFileURL(path.join(second.outputPaths.gameplay, 'scripts/main.js')).href + '?module-update');
  const native = JSON.parse(await readFile(path.join(second.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert.deepEqual(updated.manifest.dependencies[1], { module_name: '@minecraft/server', version: '2.11.0-beta' });
  assert.deepEqual(updated.manifest.optionalDependencies[0], { module_name: '@minecraft/server-admin', version: '1.0.0-beta' });
  assert.deepEqual(native.dependencies[1], updated.manifest.dependencies[1]);
  assert.equal(native.optionalDependencies, undefined);
});

test('module inference reports missing or invalid packages and invalid authoring forms', async (t) => {
  const project = await projectFor(t);
  const resolve = dependency => resolveProjectManifests({ owner: { ...project.behavior, dependencies: [dependency] } }, metadata, { dependencyRoot: project.project });

  assert.throws(() => resolve({ module_name: 'fixture-no-installed-api' }), /not installed/);
  assert.throws(() => resolve({ module_name: '../unsafe' }), /Invalid module dependency/);
  assert.throws(() => resolve({ module_name: '@minecraft/server', namespace: 'fixture_invalid', version: '2.10.0' }), /cannot declare a Core namespace/);
  await put(project.project, 'node_modules/invalid-api/package.json', JSON.stringify({ name: '@minecraft/server', version: 'latest' }));
  assert.throws(() => resolve({ module_name: 'invalid-api' }), /invalid package.version/);
  await put(project.project, 'node_modules/invalid-api/package.json', 'null');
  assert.throws(() => resolve({ module_name: 'invalid-api' }), /invalid package metadata/);
});

test('native addon packages use package version fallback and do not invent a Core namespace', async (t) => {
  const project = await projectFor(t);
  const addon = manifestFor('script');

  delete addon.header.version;
  await put(project.project, 'node_modules/native-addon/package.json', JSON.stringify({ name: 'native-addon', version: '2.3.4' }));
  await put(project.project, 'node_modules/native-addon/manifest.json', JSON.stringify(addon));
  const resolve = dependency => resolveProjectManifests({ owner: { ...project.behavior, dependencies: [dependency] } }, metadata, { dependencyRoot: project.project });
  const result = resolve({ module_name: 'native-addon' });

  assert.deepEqual(result.owner.dependencies, [{ uuid: addon.header.uuid, version: '2.3.4' }]);
  assert.throws(() => resolve({ module_name: 'native-addon', namespace: 'invented_core' }), /requested scripted Core namespace/);
  await put(project.project, 'node_modules/native-addon/package.json', JSON.stringify({ name: 'native-addon' }));
  assert.throws(() => resolve({ module_name: 'native-addon' }), /semantic dependency version/);
  assert.equal(resolve({ module_name: 'native-addon', version: '3.0.0' }).owner.dependencies[0].version, '3.0.0');
});

test('ordinary npm libraries cannot be used as addon dependencies without an exported manifest', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'node_modules/ordinary-library/package.json', JSON.stringify({ name: 'ordinary-library', version: '1.0.0', exports: { '.': './index.js' } }));
  await put(project.project, 'node_modules/ordinary-library/index.js', 'throw new Error("Library code must not execute");');
  await put(project.project, 'node_modules/ordinary-library/manifest.json', JSON.stringify(manifestFor('script')));
  assert.throws(() => resolveProjectManifests({ owner: { ...project.behavior, dependencies: [{ module_name: 'ordinary-library' }] } }, metadata, { dependencyRoot: project.project }), /must expose .\/manifest.json/);
});

test('required and optional public subpaths resolve the owning BP UUID, version and Core namespace', async (t) => {
  const project = await projectFor(t);
  const first = { ...manifestFor('script'), namespace: 'fixture_primary' };
  const second = { ...manifestFor('script'), namespace: 'fixture_secondary' };
  const root = path.join(project.project, 'node_modules/multiple-addons');

  second.header.version = '2.0.0';
  await put(root, 'package.json', JSON.stringify({ name: 'multiple-addons', exports: {
    '.': './packs/first/scripts/api.ts',
    './stats': './packs/second/scripts/api.ts',
    './manifest.json': './packs/first/manifest.json',
    './stats/manifest.json': './packs/second/manifest.json',
  } }));
  await put(root, 'packs/first/manifest.json', JSON.stringify(first));
  await put(root, 'packs/second/manifest.json', JSON.stringify(second));
  await put(root, 'packs/first/scripts/api.ts', 'throw new Error("Must not execute");');
  await put(root, 'packs/second/scripts/api.ts', 'throw new Error("Must not execute");');
  const result = resolveProjectManifests({ owner: {
    ...project.behavior,
    dependencies: [{ module_name: 'multiple-addons' }],
    optionalDependencies: [{ module_name: 'multiple-addons/stats' }],
  } }, metadata, { dependencyRoot: project.project });

  assert.deepEqual(result.owner.dependencies, [{ uuid: first.header.uuid, version: first.header.version, namespace: first.namespace }]);
  assert.deepEqual(result.owner.optionalDependencies, [{ uuid: second.header.uuid, version: '2.0.0', namespace: second.namespace }]);
  assert.throws(() => resolveProjectManifests({ owner: { ...project.behavior, dependencies: [{ module_name: 'multiple-addons/absent' }] } }, metadata, { dependencyRoot: project.project }), /must expose public entry/);
  await put(root, 'package.json', JSON.stringify({ name: 'multiple-addons', exports: { '.': './api.ts', './manifest.json': './packs/first/manifest.json' } }));
  await put(root, 'api.ts', 'throw new Error("Must not execute");');
  assert.throws(() => resolveProjectManifests({ owner: { ...project.behavior, dependencies: [{ module_name: 'multiple-addons' }] } }, metadata, { dependencyRoot: project.project }), /must be inside a pack/);
});

test('addon package manifest version changes refresh canonical imports and native load requirements', async (t) => {
  const project = await projectFor(t);
  const addon = { ...manifestFor('script'), namespace: 'fixture_installed' };
  const optional = { ...manifestFor('script'), namespace: 'fixture_optional' };

  addon.header.version = '4.1.0';
  const packageFile = await put(project.project, 'node_modules/installed-addon/package.json', JSON.stringify({ name: 'installed-addon', version: '9.0.0', exports: { './manifest.json': './packs/BP/manifest.json' } }));
  const sourceManifest = await put(project.project, 'node_modules/installed-addon/packs/BP/manifest.json', JSON.stringify(addon));

  await put(project.project, 'node_modules/optional-addon/package.json', JSON.stringify({ name: 'optional-addon', version: '1.0.0', exports: { './manifest.json': './manifest.json' } }));
  await put(project.project, 'node_modules/optional-addon/manifest.json', JSON.stringify(optional));

  project.behavior.dependencies.push({ module_name: 'installed-addon' });
  project.behavior.optionalDependencies = [{ module_name: 'optional-addon' }, { module_name: '@minecraft/server-admin', version: '1.0.0-beta' }];
  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import manifest from "../manifest.json"; export { manifest };');
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const initial = await import(pathToFileURL(path.join(first.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.deepEqual(initial.manifest.dependencies[1], { uuid: addon.header.uuid, version: '4.1.0', namespace: addon.namespace });
  assert.deepEqual(initial.manifest.optionalDependencies[0], { uuid: optional.header.uuid, version: optional.header.version, namespace: optional.namespace });
  assert(first.dependencies.includes(packageFile));
  assert(first.dependencies.includes(sourceManifest));
  addon.header.version = '4.2.0';
  await put(project.project, 'node_modules/installed-addon/packs/BP/manifest.json', JSON.stringify(addon));
  const second = await runBuild({ configPath: project.configPath, logger: {} });
  const updated = await import(pathToFileURL(path.join(second.outputPaths.gameplay, 'scripts/main.js')).href + '?addon-update');
  const native = JSON.parse(await readFile(path.join(second.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert.deepEqual(updated.manifest.dependencies[1], { uuid: addon.header.uuid, version: '4.2.0', namespace: addon.namespace });
  assert.deepEqual(native.dependencies[1], { uuid: addon.header.uuid, version: '4.2.0' });
  assert.equal(native.optionalDependencies, undefined);
  assert(!native.dependencies.some(dependency => dependency.uuid === optional.header.uuid));
});
