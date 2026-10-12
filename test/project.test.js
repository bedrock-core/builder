import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { validateConfig } from '../src/config.ts';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { compileI18n } from '@bedrock-core/builder-i18n';
import { resolveProjectManifests } from '@bedrock-core/builder-manifest';

const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function fixture(t) {
  const project = await projectFor(t);

  delete project.config.namespace;
  project.config.name = 'Human Name';
  project.config.description = 'Shared description';
  project.config.authors = ['Creator'];
  project.config.bedrockCore.addon = { creator: 'stable', pack: 'identity' };
  await writeFile(path.join(project.project, 'package.json'), JSON.stringify({ name: 'npm-name', version: '2.4.0', type: 'module' }));

  for (const [id, manifest] of [['gameplay', project.behavior], ['visuals', project.resources]]) {
    for (const field of ['name', 'description', 'version', 'min_engine_version']) {
      delete manifest.header[field];
    }

    manifest.modules.forEach(module => delete module.version);

    if (id === 'gameplay') {
      manifest.dependencies = [{ pack: 'visuals' }];
    }

    await writeFile(path.join(project.project, `packs/${id}/manifest.json`), JSON.stringify(manifest));
  }

  await writeFile(project.configPath, JSON.stringify(project.config));

  return project;
}

test('stable addon identity derives namespace without mutating configuration and rejects disagreement', async (t) => {
  const project = await fixture(t);
  const snapshot = structuredClone(project.config);

  assert.equal(validateConfig(project.config), project.config);
  assert.deepEqual(project.config, snapshot);
  project.config.namespace = 'different';
  assert.throws(() => validateConfig(project.config), /must match addon identity/);
});

test('shared metadata completes native manifests and supplies typed runtime registration without source changes', async (t) => {
  const project = await fixture(t);
  const source = await readFile(path.join(project.project, 'packs/gameplay/manifest.json'), 'utf8');

  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'import { addonManifest, project } from "@bedrock-core/generated/project"; export const metadata = { addonManifest, project };');
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const manifest = await json(path.join(result.outputPaths.gameplay, 'manifest.json'));

  assert.equal(manifest.header.version, '2.4.0');
  assert.ok(result.packs.every(pack => pack.outputPath === result.outputPaths[pack.id]));
  assert.equal(manifest.header.uuid, project.behavior.header.uuid);
  assert.equal(manifest.header.min_engine_version, '1.26.50');
  assert.equal(manifest.modules[0].version, '2.4.0');
  assert.deepEqual(manifest.dependencies, [{ uuid: project.resources.header.uuid, version: '2.4.0' }]);
  assert.deepEqual(manifest.metadata.authors, ['Creator']);
  assert.equal(await readFile(path.join(project.project, 'packs/gameplay/manifest.json'), 'utf8'), source);
  const output = await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  assert.match(output, /stable_identity/);
  assert.match(output, /npm-name/);
  assert.match(output, /Human Name/);
  assert.doesNotMatch(output, /profiles|stagedRoot|formatVersion/);
  const declaration = path.join(project.project, '.bedrock-core/generated/project.d.ts');
  const program = ts.createProgram([declaration], { noEmit: true, strict: true, types: [] });

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});

test('targeted hooks see profile-selected manifests and project invocations retain live artifact imports', async (t) => {
  const project = await fixture(t);

  await writeFile(path.join(project.project, 'packs/visuals/manifest.release.json'), JSON.stringify({ extends: './manifest.json', header: { version: '3.0.0' } }));
  project.config.bedrockCore.plugins = { probe: { module: './probe.mjs', targets: { modules: ['script'] }, scope: 'project' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'probe', after: 'prepare' }];
  project.config.bedrockCore.profiles.default.stages.manifest = { manifestPath: 'packs/visuals/manifest.release.json' };
  await writeFile(path.join(project.project, 'probe.mjs'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const owner = await context.inspectPack('gameplay');
      const file = path.join(context.packs.gameplay, 'profile.json');
      await writeFile(file, JSON.stringify(owner.dependencies));
      await context.registerArtifact('profile:probe', file, { importAs: '@generated/probe' });
      if (context.generatedImports['@generated/probe'] !== 'profile:probe') throw new Error('Stale generated imports');
    }
  `);
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal((await json(path.join(result.outputPaths.gameplay, 'profile.json')))[0].version, '3.0.0');
  assert.equal((await json(path.join(result.outputPaths.visuals, 'manifest.json'))).modules[0].version, '3.0.0');
  assert.equal((await json(path.join(result.outputPaths.gameplay, 'manifest.json'))).dependencies[0].version, '3.0.0');
});

test('i18n adds typed shared metadata and routes client strings to the local resource dependency only', async (t) => {
  const project = await fixture(t);

  await mkdir(path.join(project.project, 'packs/gameplay/i18n'));
  await writeFile(path.join(project.project, 'packs/gameplay/i18n/en_US.ts'), 'export default { greeting: "Hello", meta: { name: "Localized Name" } } as const;');
  await mkdir(path.join(project.project, 'packs/visuals/texts'), { recursive: true });
  await writeFile(path.join(project.project, 'packs/visuals/texts/cs_CZ.lang'), 'pack.name=Resource Display\npack.description=Resource Description\n');
  await mkdir(path.join(project.project, 'packs/textures'));
  await writeFile(path.join(project.project, 'packs/textures/manifest.json'), JSON.stringify(manifestFor('resources')));
  project.config.packs.textures = './packs/textures';
  project.config.bedrockCore.profiles.default.export.textures = './dist/textures';
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const resources = await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');
  const behavior = await readFile(path.join(result.outputPaths.gameplay, 'texts/en_US.lang'), 'utf8');

  assert.match(resources, /stable_identity.greeting=Hello/);
  assert.match(behavior, /pack.name=Localized Name/);
  assert.match(resources, /pack.name=Human Name/);
  assert.match(resources, /stable_identity.meta.creator=Creator/);
  assert.doesNotMatch(behavior, /stable_identity.greeting/);
  const resourceLocale = await readFile(path.join(result.outputPaths.visuals, 'texts/cs_CZ.lang'), 'utf8');

  assert.match(resourceLocale, /pack.name=Resource Display/);
  assert.doesNotMatch(resourceLocale, /pack.name=Localized Name/);
  await assert.rejects(access(path.join(result.outputPaths.textures, 'texts/en_US.lang')), { code: 'ENOENT' });
  const declaration = await readFile(path.join(project.project, '.bedrock-core/generated/i18n/gameplay/i18n.generated.d.ts'), 'utf8');

  assert.match(declaration, /readonly meta.*readonly creator: string/);
});

test('standalone translations reject conflicting authored and generated keys before changing files', async (t) => {
  const project = await fixture(t);
  const file = path.join(project.project, 'packs/visuals/texts/en_US.lang');

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'stable_identity.greeting=Different\n');
  await mkdir(path.join(project.project, 'packs/gameplay/i18n'));
  await writeFile(path.join(project.project, 'packs/gameplay/i18n/en_US.ts'), 'export default { greeting: "Hello" };');
  await assert.rejects(compileI18n({ root: project.project, sourceDir: 'packs/gameplay/i18n', namespace: 'stable_identity', packs: [{ path: 'packs/visuals', kind: 'resource' }] }), /conflicts with generated/);
  assert.equal(await readFile(file, 'utf8'), 'stable_identity.greeting=Different\n');
});

test('manifest defaults retain explicit values and reject unknown pack references and malformed native dependencies', () => {
  const manifest = manifestFor('data');
  const project = { namespace: 'test', name: 'Name', description: '', authors: [], targetVersion: '1.26.50', version: '2.0.0' };
  const snapshot = structuredClone(manifest);

  assert.equal(resolveProjectManifests({ logic: manifest }, project).logic.header.version, '1.0.0');
  assert.deepEqual(manifest, snapshot);

  for (const dependency of [{ pack: 'unknown' }, { uuid: 'invalid', version: '1.0.0' }, { uuid: manifest.header.uuid, module_name: '@minecraft/server', version: '1.0.0' }]) {
    assert.throws(() => resolveProjectManifests({ logic: { ...manifest, dependencies: [dependency] } }, project), /invalid/);
  }
});
