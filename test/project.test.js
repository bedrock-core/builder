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

  project.config.namespace = 'stable_identity';
  project.config.name = 'Human Name';
  project.config.description = 'Shared description';
  project.config.authors = ['Creator'];
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

test('project namespace is explicit and validated without mutating configuration', async (t) => {
  const project = await fixture(t);
  const snapshot = structuredClone(project.config);

  assert.equal(validateConfig(project.config), project.config);
  assert.deepEqual(project.config, snapshot);
  project.config.namespace = 'different';
  assert.equal(validateConfig(project.config), project.config);
  delete project.config.namespace;
  assert.throws(() => validateConfig(project.config), /namespace/);

  for (const namespace of ['', 'minecraft', 'Bad Namespace']) {
    project.config.namespace = namespace;
    assert.throws(() => validateConfig(project.config), /namespace/);
  }
});

test('shared metadata completes native manifests and supplies typed project data without source changes', async (t) => {
  const project = await fixture(t);
  const source = await readFile(path.join(project.project, 'packs/gameplay/manifest.json'), 'utf8');

  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'import { project } from "@bedrock-core/generated/project"; export const metadata = project;');
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
  const declarations = await readFile(declaration, 'utf8');

  assert.doesNotMatch(declarations, /addonManifest|"addon"/);
  const program = ts.createProgram([declaration], { noEmit: true, strict: true, types: [] });

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});

test('script packs retain independent authored registration identities', async (t) => {
  const project = await fixture(t);
  const identities = {
    gameplay: { creator: 'first', pack: 'gameplay', version: '1.0.0' },
    secondary: { creator: 'second', pack: 'tools', version: '3.0.0' },
  };

  project.config.packs.secondary = './packs/secondary';
  project.config.bedrockCore.profiles.default.export.secondary = './dist/secondary';
  await mkdir(path.join(project.project, 'packs/secondary/scripts'), { recursive: true });
  await writeFile(path.join(project.project, 'packs/secondary/manifest.json'), JSON.stringify(manifestFor('script')));

  for (const [id, identity] of Object.entries(identities)) {
    await writeFile(path.join(project.project, `packs/${id}/scripts/main.ts`), `export const registration = ${JSON.stringify(identity)};`);
  }

  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  for (const [id, identity] of Object.entries(identities)) {
    const source = await readFile(path.join(result.outputPaths[id], 'scripts/main.js'), 'utf8');
    const compiled = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

    assert.deepEqual(compiled.registration, identity);
  }
});

test('targeted hooks see profile-selected manifests and project invocations retain live artifact imports', async (t) => {
  const project = await fixture(t);

  await writeFile(path.join(project.project, 'packs/visuals/manifest.release.json'), JSON.stringify({ extends: './manifest.json', header: { version: '3.0.0' } }));
  project.config.bedrockCore.plugins = { probe: { module: './probe.mjs', scope: 'project' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'probe', after: 'prepare' }];
  project.config.bedrockCore.profiles.default.stages.manifest = { manifestPath: 'packs/visuals/manifest.release.json' };
  await writeFile(path.join(project.project, 'probe.mjs'), `
    export const requirements = { modules: ['script'] };
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
  assert.match(resources, /pack.name=Localized Name/);
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

test('package license and homepage fill manifest defaults while preserving authored metadata', async (t) => {
  const project = await fixture(t);
  const pkg = { name: 'licensed-project', version: '2.4.0', license: 'MIT', homepage: 'https://example.com/project', url: 'https://example.com/fallback' };

  await writeFile(path.join(project.project, 'package.json'), JSON.stringify(pkg));
  const resourceFile = path.join(project.project, 'packs/visuals/manifest.json');
  const resource = await json(resourceFile);

  resource.metadata = { authors: ['Pack author'], license: 'Apache-2.0', url: 'https://example.com/pack', generated_with: { 'custom_tool': ['1.0.0'], 'bedrock-core': ['0.0.1'] } };
  await writeFile(resourceFile, JSON.stringify(resource));
  const source = await readFile(resourceFile, 'utf8');
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const behavior = (await json(path.join(result.outputPaths.gameplay, 'manifest.json'))).metadata;
  const metadata = (await json(path.join(result.outputPaths.visuals, 'manifest.json'))).metadata;

  assert.deepEqual(behavior.authors, ['Creator']);
  assert.equal(behavior.license, 'MIT');
  assert.equal(behavior.url, pkg.homepage);
  assert.equal(behavior.product_type, undefined);
  assert.deepEqual(metadata.authors, ['Pack author']);
  assert.equal(metadata.license, 'Apache-2.0');
  assert.equal(metadata.url, 'https://example.com/pack');
  assert.deepEqual(metadata.generated_with.custom_tool, ['1.0.0']);
  assert.deepEqual(metadata.generated_with['bedrock-core'], ['0.0.1', ...behavior.generated_with['bedrock-core']]);
  assert.equal(await readFile(resourceFile, 'utf8'), source);
  assert.ok(result.dependencies.includes(path.join(project.project, 'package.json')));
  const again = resolveProjectManifests({ visuals: await json(path.join(result.outputPaths.visuals, 'manifest.json')) }, { namespace: 'test', name: 'Name', description: '', authors: [], targetVersion: '1.26.50' });

  assert.deepEqual(again.visuals.metadata.generated_with, metadata.generated_with);
});

test('root license text and package URL are tracked across rebuilds', async (t) => {
  const project = await fixture(t);

  await writeFile(path.join(project.project, 'package.json'), JSON.stringify({ version: '2.4.0', url: 'https://example.com' }));
  const license = path.join(project.project, 'LICENSE');

  await writeFile(license, 'License text\nCopyright Example\n');
  let result = await runBuild({ configPath: project.configPath, logger: {} });
  let metadata = (await json(path.join(result.outputPaths.gameplay, 'manifest.json'))).metadata;

  assert.equal(metadata.license, 'License text\nCopyright Example');
  assert.equal(metadata.url, 'https://example.com');
  assert.ok(result.dependencies.includes(license));
  await writeFile(license, 'Updated license text');
  result = await runBuild({ configPath: project.configPath, logger: {} });
  metadata = (await json(path.join(result.outputPaths.gameplay, 'manifest.json'))).metadata;
  assert.equal(metadata.license, 'Updated license text');
  await writeFile(path.join(project.project, 'package.json'), JSON.stringify({ version: '2.4.0', license: 'SEE LICENSE IN terms.txt' }));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /license file is missing or empty/);
  await writeFile(path.join(project.project, 'terms.txt'), 'Custom terms');
  result = await runBuild({ configPath: project.configPath, logger: {} });
  assert.equal((await json(path.join(result.outputPaths.gameplay, 'manifest.json'))).metadata.license, 'Custom terms');
});

test('manifest tool metadata rejects malformed authored values', () => {
  const project = { namespace: 'test', name: 'Name', description: '', authors: [], targetVersion: '1.26.50' };

  for (const metadata of [[], { generated_with: [] }, { generated_with: { 'bedrock-core': '1.0.0' } }, { generated_with: { 'bedrock-core': ['invalid'] } }]) {
    assert.throws(() => resolveProjectManifests({ logic: { ...manifestFor('data'), metadata } }, project), /metadata/);
  }
});
