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
    name: 'Validation', authors: [], namespace: 'validation',
    targetVersion: '1.26.50', packs: { gameplay: './packs/BP' },
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

test('official block validation resolves the pinned legacy Molang reference and still rejects invalid components', async (t) => {
  const project = await fixture(t);
  const blocks = path.join(project.packs[0].path, 'blocks');
  const file = path.join(blocks, 'container.json');

  await mkdir(blocks);
  await writeFile(file, JSON.stringify({ 'format_version': '1.21.120', 'minecraft:block': {
    description: { identifier: 'validation:owned_container' }, components: { 'minecraft:friction': 0.6 },
  } }));
  const dependencies = new Set();
  const result = await validatePackContent({ ...project, reuse: async (_file, inputs, _revision, validate) => {
    inputs.forEach(input => dependencies.add(input));

    return validate();
  } });
  const block = result.files.find(entry => entry.file === 'blocks/container.json');

  assert.match(block.schema, /bp\/blocks/);
  assert.equal(block.schemaIssue, undefined);
  assert.ok([...dependencies].some(input => input.endsWith('molang_expression.schema.json')));
  await writeFile(file, JSON.stringify({ 'format_version': '1.21.120', 'minecraft:block': {
    description: { identifier: 'validation:owned_container' }, components: { 'minecraft:friction': 'invalid' },
  } }));
  await assert.rejects(validatePackContent(project), ContentValidationError);
});

test('custom schema roots retain their own unresolved references without applying package aliases', async (t) => {
  const project = await fixture(t);
  const schemaRoot = path.join(project.root, 'custom-schema');

  await mkdir(path.join(schemaRoot, 'schemas/common'), { recursive: true });
  await mkdir(path.join(schemaRoot, 'schemas/bp'));
  await writeFile(path.join(schemaRoot, 'package.json'), JSON.stringify({ version: '1.26.50' }));
  await writeFile(path.join(schemaRoot, 'catalog.json'), JSON.stringify({ schemas: [
    { url: './schemas/bp/example.json', fileMatch: ['loot_tables/**/*.json'] },
  ] }));
  await writeFile(path.join(schemaRoot, 'schemas/bp/example.json'), JSON.stringify({ $ref: '../common/expression.schema.json' }));
  await writeFile(path.join(schemaRoot, 'schemas/common/molang_expression.schema.json'), JSON.stringify({ type: 'object' }));
  await writeFile(project.source, '{}');
  const result = await validatePackContent({ ...project, schemaRoot });

  const content = result.files.find(entry => entry.file === 'loot_tables/example.json');

  assert.equal(content.schema, undefined);
  assert.match(content.schemaIssue, /expression\.schema\.json/);
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
