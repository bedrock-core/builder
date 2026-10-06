import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { generateSchemaTypes, generateTemplates } from '../packages/generator/src/index.ts';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';
import { seedSchemas } from '../test-support/schemas.js';

function diagnostics(files) {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: false,
  });

  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('generated global types support the documented single and Many default exports without helpers', async (t) => {
  const { project } = await projectFor(t);
  const { version } = await seedSchemas(project);

  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network access');
  });
  const result = await generateSchemaTypes({ root: project, schemaVersion: version });
  const globals = path.join(result.outputPath, 'globals.d.ts');
  const entity = path.join(project, 'packs/gameplay/training_dummy.entity.ts');
  const blocks = path.join(project, 'packs/gameplay/ores.ts');

  await writeFile(entity, `
    export default {
      format_version: '1.21.0',
      'minecraft:entity': {
        description: { identifier: 'example:training_dummy', is_summonable: true },
        components: { 'minecraft:health': { value: 20, max: 20 }, 'minecraft:physics': {} },
      },
    } satisfies Entity;
  `);
  await writeFile(blocks, `
    type Options = { id: string; mapColor: string; light?: number };
    export default [
      (o) => o.id + '.json',
      (o) => ({
        format_version: '1.21.0',
        'minecraft:block': {
          description: { identifier: 'example:' + o.id },
          components: { 'minecraft:map_color': o.mapColor, 'minecraft:light_emission': o.light ?? 0 },
        },
      }),
      [{ id: 'ruby_ore', mapColor: '#c0392b' }, { id: 'sapphire_ore', mapColor: '#2980b9', light: 7 }],
    ] satisfies Many<Options, Block>;
  `);
  assert.deepEqual(diagnostics([globals, entity, blocks]), []);
  const generated = await generateTemplates({ root: project, files: [entity, blocks] });

  assert.deepEqual(generated.documents.map(document => path.basename(document.path)).sort(), ['ruby_ore.json', 'sapphire_ore.json', 'training_dummy.entity.json']);
  assert.equal(generated.documents.find(document => document.path.endsWith('sapphire_ore.json')).value['minecraft:block'].components['minecraft:light_emission'], 7);
  assert.equal(generated.documents.find(document => document.path.endsWith('training_dummy.entity.json')).value['minecraft:entity'].components['minecraft:health'].value, 20);
  await writeFile(entity, `export default { 'minecraft:entity': { components: { 'minecraft:health': { value: 'invalid' } } } } satisfies Entity;`);
  assert.equal(diagnostics([globals, entity]).some(message => message.includes('Type \'string\' is not assignable to type \'number\'')), true);
});

test('schema aliases, prefix, strict checking and unchanged declaration caching match their settings', async (t) => {
  const { project } = await projectFor(t);
  const { version } = await seedSchemas(project);
  const initial = await generateSchemaTypes({ root: project, schemaVersion: version });
  const globals = path.join(initial.outputPath, 'globals.d.ts');
  const modified = (await stat(globals)).mtimeMs;
  const cached = await generateSchemaTypes({ root: project, schemaVersion: version });

  assert.equal(initial.changed, true);
  assert.equal(cached.changed, false);
  assert.equal((await stat(globals)).mtimeMs, modified);
  assert.match(await readFile(globals, 'utf8'), /declare type BpAnimation/);
  assert.match(await readFile(globals, 'utf8'), /declare type RpEntity/);
  const strict = await generateSchemaTypes({ root: project, schemaVersion: version, strict: true, typePrefix: 'Mc' });
  const template = path.join(project, 'strict.ts');

  assert.equal(strict.changed, true);
  await writeFile(template, `
    const entity = { format_version: '1.21.0' } satisfies McEntity;
    const many = [() => 'example', () => entity, [1]] satisfies McMany<number, McEntity>;
    void many;
  `);
  assert.deepEqual(diagnostics([globals, template]), []);
  await writeFile(template, 'export default { invented: true } satisfies McEntity;');
  assert.equal(diagnostics([globals, template]).some(message => message.includes('invented')), true);
});

test('simple schema properties inline with documentation and document roots remain exported', async (t) => {
  const { project } = await projectFor(t);
  const { version } = await seedSchemas(project);
  const result = await generateSchemaTypes({ root: project, schemaVersion: version });
  const entity = await readFile(path.join(result.outputPath, 'bp/entities.d.ts'), 'utf8');
  const block = await readFile(path.join(result.outputPath, 'bp/blocks.d.ts'), 'utf8');

  assert.doesNotMatch(entity + block, /export type \w+ = (?:unknown|number)\b/);
  assert.match(entity, /Controls entity physics\.[\s\S]*?"minecraft:physics"\?: unknown/);
  assert.match(entity, /Uses a schema not supplied by this package\.[\s\S]*?"missing:component"\?: unknown/);
  assert.match(block, /Sets the color on maps\.[\s\S]*?"minecraft:map_color"\?: unknown/);
  assert.match(block, /Controls the emitted light level\.[\s\S]*?"minecraft:light_emission"\?: number/);
  assert.doesNotMatch(block, /export type BlockMode/);
  assert.match(block, /"example:mode"\?: \("solid" \| "transparent"\)/);
  assert.match(block, /export interface BlockBehaviorDocument/);
  assert.deepEqual(diagnostics([path.join(result.outputPath, 'globals.d.ts')]), []);
});

test('generator stage prepares editor declarations by default even with no templates', async (t) => {
  const { project, config, configPath } = await projectFor(t);

  await seedSchemas(project);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network access');
  });
  config.bedrockCore.profiles.default.stages.generator = true;
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });

  assert.match(await readFile(path.join(project, '.bedrock-core/generated/mc/globals.d.ts'), 'utf8'), /declare type Entity/);
  await assert.rejects(readFile(path.join(result.outputPaths.gameplay, '.bedrock-core/generated/mc/globals.d.ts')), { code: 'ENOENT' });
});

test('type-generation failures preserve authored directories and previously generated declarations', async (t) => {
  const { project } = await projectFor(t);
  const { version } = await seedSchemas(project);
  const initial = await generateSchemaTypes({ root: project, schemaVersion: version });
  const globals = path.join(initial.outputPath, 'globals.d.ts');
  const previous = await readFile(globals, 'utf8');
  const authored = path.join(project, 'authored-types');

  await mkdir(authored);
  await writeFile(path.join(authored, 'keep.d.ts'), 'declare const keep: true;');
  await assert.rejects(generateSchemaTypes({ root: project, schemaVersion: version, typesDir: 'authored-types' }), /authored content/);
  assert.equal(await readFile(path.join(authored, 'keep.d.ts'), 'utf8'), 'declare const keep: true;');
  const broken = await seedSchemas(project, '2.0.0-test');

  await writeFile(path.join(broken.root, 'catalog.json'), '{"schemas":[]}');
  await assert.rejects(generateSchemaTypes({ root: project, schemaVersion: broken.version }), /No Minecraft schema categories/);
  assert.equal(await readFile(globals, 'utf8'), previous);
});
