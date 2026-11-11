import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import { resolveProjectManifests } from '@bedrock-core/builder-manifest';
import { projectFor, put } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { runBuild } from '../src/run.ts';

const external = { uuid: 'ea546667-1a7b-437f-8fbc-a86683daa223', version: '2.0.0', namespace: 'fixture_external' };
const projectMetadata = { name: 'Optional fixtures', description: '', authors: [], targetVersion: '1.26.50' };

test('optional local selectors resolve like required dependencies without entering native output or its graph', async (t) => {
  const project = await projectFor(t);
  const library = manifestFor('script', 'scripts/main.ts');

  library.namespace = 'fixture_library';
  project.behavior.optionalDependencies = [{ namespace: library.namespace }, external, { module_name: '@minecraft/server-admin', version: '1.0.0-beta' }];
  project.config.packs.library = './packs/library';
  project.config.bedrockCore.profiles.default.export.library = './dist/library';
  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'packs/library/manifest.json', JSON.stringify(library));
  await put(project.project, 'packs/library/scripts/main.ts', 'export const library = true;');
  await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import manifest from "../manifest.json"; export { manifest };');
  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const { manifest } = await import(pathToFileURL(path.join(result.outputPaths.gameplay, 'scripts/main.js')).href);
  const native = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'));
  const authored = JSON.parse(await readFile(path.join(project.project, 'packs/gameplay/manifest.json'), 'utf8'));

  assert.deepEqual(manifest.optionalDependencies, [
    { uuid: library.header.uuid, version: library.header.version, namespace: library.namespace },
    external,
    { module_name: '@minecraft/server-admin', version: '1.0.0-beta' },
  ]);
  assert.equal(native.optionalDependencies, undefined);
  assert.equal(native.dependencies.length, 1);
  assert.equal(native.dependencies[0].uuid, project.resources.header.uuid);
  assert(!result.packs.find(pack => pack.id === 'gameplay').dependencies.some(dependency => dependency.packId === 'library'));
  assert.deepEqual(authored.optionalDependencies[0], { namespace: library.namespace });
});

test('required and optional dependency arrays share the same authored schema item definition', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/pack-manifest.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);

  assert.deepEqual(schema.properties.dependencies.items, schema.properties.optionalDependencies.items);

  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const dependency of [{ namespace: 'fixture_library' }, external, { uuid: external.uuid }, { module_name: '@minecraft/server' }, { module_name: '@minecraft/server', version: '2.10.0' }]) {
      assert.equal(validate({ ...manifestFor('script'), namespace: 'fixture_owner', [field]: [dependency] }), true, JSON.stringify(validate.errors));
    }

    for (const dependency of ['fixture_legacy', { pack: 'library' }, { module: '@minecraft/server' }, { module_name: '@minecraft/server', version: '2.10.0', namespace: 'fixture_invalid' }]) {
      assert.equal(validate({ ...manifestFor('script'), namespace: 'fixture_owner', [field]: [dependency] }), false);
    }
  }
});

test('optional dependencies reject legacy strings, invalid native versions, self references and required overlap', () => {
  const owner = { ...manifestFor('script'), namespace: 'fixture_owner' };

  for (const optionalDependencies of [['fixture_legacy'], [{ ...external, version: [1, 0, 0] }], [{ ...external, uuid: 'invalid' }]]) {
    assert.throws(() => resolveProjectManifests({ owner: { ...owner, optionalDependencies } }, projectMetadata), /optionalDependencies/);
  }

  assert.throws(() => resolveProjectManifests({ owner: { ...owner, optionalDependencies: [{ ...external, namespace: owner.namespace }] } }, projectMetadata), /own addon namespace/);
  assert.throws(() => resolveProjectManifests({ owner: { ...owner, dependencies: [external], optionalDependencies: [external] } }, projectMetadata), /both required and optional/);
});
