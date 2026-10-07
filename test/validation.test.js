import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePackContent, ContentValidationError } from '../packages/validation/src/index.ts';
import { runBuild } from '../src/run.ts';
import { manifestFor } from '../test-support/manifest.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-validation-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packs/BP/loot_tables'), { recursive: true });
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifestFor('data')));
  const source = path.join(root, 'packs/BP/loot_tables/example.json');
  const config = {
    type: 'minecraftBedrock', name: 'Validation', authors: [], namespace: 'validation',
    targetVersion: '1.26.50', worlds: [], packs: { gameplay: './packs/BP' },
    bedrockCore: { formatVersion: '1.0.0', profiles: { default: { export: { gameplay: './dist/BP' } } } },
  };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, source, config, configPath, packs: [{ id: 'gameplay', path: path.join(root, 'packs/BP'), kind: 'behavior' }] };
}

test('content validation follows nested official schema references and supports JSON comments', async (t) => {
  const project = await fixture(t);

  await writeFile(project.source, '{ "pools": [{ /* pool */ "rolls": 1, "entries": [{"type":"item","name":"minecraft:apple","weight":1}], }], }');
  const result = await validatePackContent(project);

  assert.equal(result.schemaVersion, '1.26.50');
  assert.match(result.files[0].schema, /bp\/loot_tables/);
  await writeFile(project.source, '{"pools":[{"rolls":"invalid","entries":[]}]}');
  await assert.rejects(validatePackContent(project), (error) => {
    assert.ok(error instanceof ContentValidationError);
    assert.ok(error.diagnostics.some(issue => issue.pointer === '/pools/0/rolls'));

    return true;
  });
});

test('unknown JSON receives syntax validation and reports schema coverage accurately', async (t) => {
  const project = await fixture(t);
  const unknown = path.join(project.packs[0].path, 'custom.json');

  await writeFile(unknown, '{"custom":true}');
  const result = await validatePackContent(project);

  assert.equal(result.files[0].schema, undefined);
  await writeFile(unknown, '{"custom":}');
  await assert.rejects(validatePackContent(project), /gameplay\/custom.json/);
});

test('final validation rejects hook output, preserves previous exports and recovers on repair', async (t) => {
  const project = await fixture(t);

  await writeFile(project.source, '{"pools":[{"rolls":1,"entries":[]}]}');
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const output = path.join(project.root, 'dist/BP/loot_tables/example.json');
  const previous = await readFile(output, 'utf8');

  project.config.bedrockCore.plugins = { corrupt: { module: './corrupt.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'corrupt', before: 'export' }];
  await writeFile(path.join(project.root, 'corrupt.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      await writeFile(path.join(context.packs.gameplay, 'loot_tables/example.json'), '{"pools":[{"entries":"invalid"}]}');
    }
  `);
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild(options), /Invalid pack content/);
  assert.equal(await readFile(output, 'utf8'), previous);
  await writeFile(path.join(project.root, 'corrupt.ts'), 'export async function run() {}');
  await runBuild(options);
});

test('validation reuses unchanged files and checks only the edited document', async (t) => {
  const project = await fixture(t);

  await writeFile(project.source, '{"pools":[]}');
  await writeFile(path.join(project.packs[0].path, 'custom.json'), '{}');
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const unchanged = await runBuild(options);

  assert.equal(unchanged.compilations.filter(item => item.id.startsWith('validate/') && item.status === 'cached').length, 2);
  await writeFile(project.source, '{"pools":[{"entries":[]}]}');
  const edited = await runBuild(options);

  assert.equal(edited.compilations.filter(item => item.id.startsWith('validate/') && item.status === 'executed').length, 1);
  assert.equal(edited.compilations.filter(item => item.id.startsWith('validate/') && item.status === 'cached').length, 1);
});
