import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { runBuild } from '../src/run.ts';
import { resolveProjectManifests } from '@bedrock-core/builder-manifest';

test('manifest imports retain addon metadata while native exports contain only pack requirements', async (t) => {
  const project = await projectFor(t);
  const owner = path.join(project.project, 'packs/gameplay');
  const provider = manifestFor('script');

  provider.modules[0].type = 'script';
  provider.modules[0].language = 'javascript';
  provider.modules[0].entry = 'scripts/main.js';
  provider.namespace = 'fixture_library';
  project.behavior.dependencies.push({ namespace: provider.namespace });
  const optionalDependency = { uuid: '3cfb6977-ff08-4c99-8d7f-ce2c70e71911', version: '1.0.0', namespace: 'fixture_optional' };

  project.behavior.optionalDependencies = [optionalDependency];
  project.config.packs.library = './packs/library';
  project.config.bedrockCore.profiles.default.export.library = './dist/library';
  await mkdir(path.join(project.project, 'packs/library/scripts'), { recursive: true });
  await writeFile(path.join(project.project, 'packs/library/manifest.json'), JSON.stringify(provider));
  await writeFile(path.join(project.project, 'packs/library/scripts/main.js'), 'export const library = true;');
  await writeFile(path.join(owner, 'manifest.json'), JSON.stringify(project.behavior));
  await writeFile(path.join(owner, 'scripts/main.ts'), 'import manifest from "../manifest.json"; export { manifest };');
  await writeFile(path.join(project.project, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const { manifest } = await import(pathToFileURL(path.join(result.outputPaths.gameplay, 'scripts/main.js')).href);
  const native = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert.equal(manifest.namespace, 'flow_test');
  assert.deepEqual(manifest.optionalDependencies, [optionalDependency]);
  assert.equal(manifest.dependencies[1].namespace, 'fixture_library');
  assert.equal(native.namespace, undefined);
  assert.equal(native.optionalDependencies, undefined);
  assert.equal(native.dependencies[1].namespace, undefined);
  assert.equal(native.dependencies[1].uuid, provider.header.uuid);
  assert.equal(native.dependencies[1].version, provider.header.version);
  assert(!result.artifacts.some(artifact => artifact.id === 'project:metadata'));
  const warm = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  project.behavior.namespace = 'flow_updated';
  await writeFile(path.join(owner, 'manifest.json'), JSON.stringify(project.behavior));
  const changed = await runBuild({ configPath: project.configPath, logger: {} });
  const updated = await import(pathToFileURL(path.join(changed.outputPaths.gameplay, 'scripts/main.js')).href + '?updated');

  assert.equal(updated.manifest.namespace, 'flow_updated');
});

test('pack artwork is copied to namespaced textures and thumbnail imports resolve before native export', async (t) => {
  const project = await projectFor(t);
  const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

  await writeFile(path.join(project.project, 'packs/gameplay/pack_icon.png'), icon);
  await writeFile(path.join(project.project, 'packs/gameplay/banner.png'), icon);
  project.behavior.thumbnail = 'banner.png';
  project.behavior.icon = 'unused.png';
  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(project.behavior));
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'import manifest from "../manifest.json"; export { manifest };');
  await writeFile(path.join(project.project, 'package.json'), JSON.stringify({ type: 'module' }));
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const { manifest } = await import(pathToFileURL(path.join(result.outputPaths.gameplay, 'scripts/main.js')).href);
  const native = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'));
  const authored = JSON.parse(await readFile(path.join(project.project, 'packs/gameplay/manifest.json'), 'utf8'));

  assert((await readFile(path.join(result.outputPaths.visuals, 'textures/flow_test/pack_icon.png'))).equals(icon));
  assert((await readFile(path.join(result.outputPaths.gameplay, 'pack_icon.png'))).equals(icon));
  assert((await readFile(path.join(result.outputPaths.visuals, 'textures/flow_test/thumbnail.png'))).equals(icon));
  assert.equal(manifest.thumbnail, 'textures/flow_test/thumbnail');
  assert.equal(authored.thumbnail, 'banner.png');
  assert.equal(native.thumbnail, undefined);
  assert.equal(native.icon, undefined);
});

test('resource-root icons are used as fallback and conflicting authored textures are protected', async (t) => {
  const project = await projectFor(t);
  const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

  await writeFile(path.join(project.project, 'packs/visuals/pack_icon.png'), icon);
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const copied = path.join(result.outputPaths.visuals, 'textures/flow_test/pack_icon.png');

  assert((await readFile(copied)).equals(icon));
  await mkdir(path.join(project.project, 'packs/visuals/textures/flow_test'), { recursive: true });
  await writeFile(path.join(project.project, 'packs/visuals/textures/flow_test/pack_icon.png'), 'conflicting texture');
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /overwrite a different texture/);
  assert((await readFile(copied)).equals(icon));
});

test('pack display keys come from locale resources and retain their native manifest names', async (t) => {
  const project = await projectFor(t);

  project.behavior.header.name = 'pack.name';
  project.behavior.header.description = 'pack.description';
  project.resources.header.name = 'pack.name';
  project.resources.header.description = 'pack.description';
  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(project.behavior));
  await writeFile(path.join(project.project, 'packs/visuals/manifest.json'), JSON.stringify(project.resources));
  await mkdir(path.join(project.project, 'packs/gameplay/i18n'), { recursive: true });
  await writeFile(path.join(project.project, 'packs/gameplay/i18n/en_US.ts'), 'export default { pack: { name: "Localized addon", description: "Localized description" } } as const;');
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const language = await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');
  const native = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert.match(language, /(?:^|\n)pack\.name=Localized addon(?:\n|$)/);
  assert.match(language, /(?:^|\n)flow_test\.pack\.name=Localized addon(?:\n|$)/);
  assert.match(language, /(?:^|\n)pack\.description=Localized description(?:\n|$)/);
  assert.doesNotMatch(language, /__manifest/);
  assert.equal(native.header.name, 'pack.name');
  assert.equal(native.header.description, 'pack.description');
});

test('scripted pack namespaces must be unique and explicit project namespace fields are rejected', async (t) => {
  const project = await projectFor(t);
  const duplicate = structuredClone(project.behavior);

  duplicate.header.uuid = project.resources.header.uuid;
  duplicate.modules[0].uuid = project.resources.modules[0].uuid;
  assert.throws(() => resolveProjectManifests({ first: project.behavior, second: duplicate }, {
    name: 'Project', description: '', authors: [], targetVersion: '1.26.50',
  }), /Duplicate addon namespace/);
  project.config.namespace = 'removed';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /manifest.json/);
});
