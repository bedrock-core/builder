import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { generateTemplates } from '../packages/generator/src/index.ts';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';

test('published document types check single and tuple templates without schema preparation', async (t) => {
  const { project } = await projectFor(t);
  const scope = path.join(project, 'node_modules/@bedrock-core');

  await mkdir(scope, { recursive: true });

  for (const [name, folder] of [['bedrock-types', 'bedrock-types'], ['builder-generator', 'generator']]) {
    await symlink(fileURLToPath(new URL('../packages/' + folder, import.meta.url)), path.join(scope, name), process.platform === 'win32' ? 'junction' : 'dir');
  }

  await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
  const entity = path.join(project, 'packs/gameplay/training_dummy.entity.ts');
  const blocks = path.join(project, 'packs/gameplay/ores.ts');

  await writeFile(entity, `
    import type { EntityDocument } from '@bedrock-core/bedrock-types';
    export default { format_version: '1.21.0', 'minecraft:entity': { description: { identifier: 'example:training_dummy', is_summonable: true }, components: { 'minecraft:health': { value: 20, max: 20 } } } } satisfies EntityDocument;
  `);
  await writeFile(blocks, `
    import type { BlockDocument } from '@bedrock-core/bedrock-types';
    import type { ManyTemplate } from '@bedrock-core/builder-generator/templates';
    type Options = { id: string; light: number };
    export default [
      options => options.id,
      options => ({ format_version: '1.26.60', 'minecraft:block': { description: { identifier: 'example:' + options.id }, components: { 'minecraft:light_emission': options.light } } }),
      [{ id: 'ruby_ore', light: 3 }, { id: 'sapphire_ore', light: 7 }],
    ] satisfies ManyTemplate<Options, BlockDocument>;
  `);
  const program = ts.createProgram([entity, blocks], { strict: true, noEmit: true, skipLibCheck: false, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext, allowImportingTsExtensions: true, types: [] });

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(value => ts.flattenDiagnosticMessageText(value.messageText, '\n')), []);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Template execution must not fetch schemas');
  });
  const generated = await generateTemplates({ root: project, files: [entity, blocks] });

  assert.deepEqual(generated.documents.map(document => path.basename(document.path)).sort(), ['ruby_ore.json', 'sapphire_ore.json', 'training_dummy.entity.json']);
  assert.equal(generated.documents.find(document => document.path.endsWith('sapphire_ore.json')).value['minecraft:block'].components['minecraft:light_emission'], 7);
  await assert.rejects(access(path.join(project, '.bedrock-core/generated/mc')), { code: 'ENOENT' });
});

test('the generator stage writes JSON without producing editor declarations or fetching schema data', async (t) => {
  const { project, config, configPath } = await projectFor(t);

  config.bedrockCore.profiles.default.stages.generator = true;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(project, 'packs/visuals/example.ts'), 'export default { value: 7 };');
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Content generation must not download schemas');
  });
  const result = await runBuild({ configPath, logger: {} });

  assert.equal(await readFile(path.join(result.outputPaths.visuals, 'example.json'), 'utf8'), '{"value":7}');
  await assert.rejects(access(path.join(project, '.bedrock-core/generated/mc')), { code: 'ENOENT' });
});
