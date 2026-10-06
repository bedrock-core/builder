import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateTemplates, defineMany, defineTemplate } from '../packages/generator/src/index.ts';
import { runBuild } from '../src/run.ts';
import { validateConfig } from '../src/config.ts';
import { projectFor } from '../test-support/project.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-generator-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('standalone templates import TypeScript, JavaScript and JSON without the runner', async (t) => {
  const root = await fixture(t);
  const source = `
    import data from './value.json';
    import { double } from './helper.ts';
    import { suffix } from './suffix.js';
    const value: number = double(data.value);
    export default { value, suffix };
  `;

  await writeFile(path.join(root, 'value.json'), '{"value":7}');
  await writeFile(path.join(root, 'helper.ts'), 'export const double = (value: number): number => value * 2;');
  await writeFile(path.join(root, 'suffix.js'), 'export const suffix = "example";');
  await writeFile(path.join(root, 'template.ts'), source);
  const validated = [];
  const result = await generateTemplates({
    root,
    files: ['template.ts'],
    pretty: { indent: 'space', size: 2 },
    validate(document) {
      validated.push(document.value);
    },
  });

  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'template.json'), 'utf8')), { value: 14, suffix: 'example' });
  assert.match(await readFile(path.join(root, 'template.json'), 'utf8'), /\n {2}"value"/);
  assert.equal(await readFile(path.join(root, 'template.ts'), 'utf8'), source);
  assert.deepEqual(validated, [{ value: 14, suffix: 'example' }]);
  assert.deepEqual(result.templates, [path.join(root, 'template.ts')]);
  assert.deepEqual(new Set(result.inputs.filter(file => file.startsWith(root))), new Set(['template.ts', 'value.json', 'helper.ts', 'suffix.js'].map(file => path.join(root, file))));
});

test('typed helper entry produces multiple documents with async name and data callbacks', async (t) => {
  const root = await fixture(t);
  const helperPath = path.resolve(import.meta.dirname, '../packages/generator/src/templates.ts').replaceAll('\\', '/');

  await writeFile(path.join(root, 'many.mts'), `
    import { defineMany } from ${JSON.stringify(helperPath)};
    export default defineMany(
      async (value: number) => 'item-' + value + '.json',
      async (value: number) => ({ value }),
      [1, 2],
    );
  `);
  const result = await generateTemplates({ root, files: ['many.mts'], pretty: { indent: 'tab' } });

  assert.deepEqual(result.documents.map(document => path.basename(document.path)), ['item-1.json', 'item-2.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'item-2.json'), 'utf8')), { value: 2 });
  assert.match(await readFile(path.join(root, 'item-2.json'), 'utf8'), /\n\t"value"/);
  assert.equal(defineTemplate(7), 7);
  assert.equal(defineMany(String, value => value, [1, 2]).length, 3);
});

test('automatic helpers retain default exports, category tags and inferred collection callbacks', async (t) => {
  const root = await fixture(t);

  await writeFile(path.join(root, 'single.ts'), `export default defineTemplate('bp/items', { value: 1 });`);
  await writeFile(path.join(root, 'plain.ts'), 'export default defineTemplate({ value: 2 });');
  await writeFile(path.join(root, 'many.ts'), `
    export default defineMany(
      'bp/loot_tables',
      item => item.id,
      async item => ({ value: item.value }),
      [{ id: 'first', value: 3 }, { id: 'second', value: 4 }],
    );
  `);
  await writeFile(path.join(root, 'untagged.ts'), `export default defineMany(item => 'untagged-' + item, item => ({ value: item }), [5]);`);
  const result = await generateTemplates({ root, files: ['single.ts', 'plain.ts', 'many.ts', 'untagged.ts'] });
  const categories = Object.fromEntries(result.documents.map(document => [path.basename(document.path), document.category]));

  assert.deepEqual(categories, { 'first.json': 'bp/loot_tables', 'second.json': 'bp/loot_tables', 'plain.json': undefined, 'single.json': 'bp/items', 'untagged-5.json': undefined });
  assert.equal(await readFile(path.join(root, 'single.json'), 'utf8'), '{"value":1}');
  assert.equal(await readFile(path.join(root, 'second.json'), 'utf8'), '{"value":4}');
  assert.equal(Object.hasOwn(globalThis, 'defineTemplate'), false);
  assert.equal(Object.hasOwn(globalThis, 'defineMany'), false);
});

test('automatic helper injection respects a template local helper binding', async (t) => {
  const root = await fixture(t);

  await writeFile(path.join(root, 'local.ts'), `
    const defineTemplate = (value: number) => ({ local: value });
    export default defineTemplate(8);
  `);
  const result = await generateTemplates({ root, files: ['local.ts'] });

  assert.deepEqual(result.documents[0].value, { local: 8 });
});

test('Node templates resolve npm CommonJS, Node built-ins, tsconfig aliases and registered inputs', async (t) => {
  const root = await fixture(t);
  const dependencies = path.join(root, 'installation');

  await mkdir(path.join(dependencies, 'node_modules/test-dependency'), { recursive: true });
  await writeFile(path.join(dependencies, 'node_modules/test-dependency/package.json'), '{"name":"test-dependency","main":"index.cjs"}');
  await writeFile(path.join(dependencies, 'node_modules/test-dependency/index.cjs'), 'const path = require("node:path"); module.exports = { leaf: path.basename("/folder/npm") };');
  await writeFile(path.join(root, 'helper.ts'), 'export const value = 12;');
  await writeFile(path.join(root, 'artifact.json'), '{"value":3}');
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@local/*': ['./*'] } } }));
  await writeFile(path.join(root, 'template.ts'), `
    import { basename } from 'node:path';
    import dependency from 'test-dependency';
    import { value } from '@local/helper';
    import artifact from '@bedrock-core/generated/input';
    export default { value: value * artifact.value, leaf: basename('/folder/node'), dependency: dependency.leaf };
  `);
  const result = await generateTemplates({
    root,
    files: ['template.ts'],
    dependencyRoot: dependencies,
    aliases: { '@bedrock-core/generated/input': 'artifact.json' },
    tsconfig: 'tsconfig.json',
  });

  assert.deepEqual(result.documents[0].value, { value: 36, leaf: 'node', dependency: 'npm' });
  assert.equal(result.inputs.includes(path.join(root, 'tsconfig.json')), true);
  assert.equal(result.inputs.includes(path.join(dependencies, 'node_modules/test-dependency/index.cjs')), true);
});

test('all templates evaluate before any JSON is written', async (t) => {
  const root = await fixture(t);

  await writeFile(path.join(root, 'a.ts'), 'export default { valid: true };');
  await writeFile(path.join(root, 'b.ts'), 'throw new Error("template failed"); export default {};');
  await assert.rejects(generateTemplates({ root, files: ['a.ts', 'b.ts'] }), /template failed/);
  assert.deepEqual(await readdir(root), ['a.ts', 'b.ts']);
  await writeFile(path.join(root, 'b.ts'), 'export default { valid: true };');
  await assert.rejects(generateTemplates({
    root,
    files: ['a.ts', 'b.ts'],
    validate(document) {
      if (document.path.endsWith('b.json')) {
        throw new Error('invalid generated content');
      }
    },
  }), /invalid generated content/);
  assert.deepEqual(await readdir(root), ['a.ts', 'b.ts']);
});

test('templates replace staged JSON and repeated names keep the final generated document', async (t) => {
  const root = await fixture(t);

  await writeFile(path.join(root, 'a.ts'), 'export default { valid: true };');
  await writeFile(path.join(root, 'b.ts'), 'export default { valid: true };');
  await writeFile(path.join(root, 'b.json'), '{"authored":true}');
  await generateTemplates({ root, files: ['a.ts', 'b.ts'] });
  assert.equal(await readFile(path.join(root, 'a.json'), 'utf8'), '{"valid":true}');
  assert.equal(await readFile(path.join(root, 'b.json'), 'utf8'), '{"valid":true}');
  await writeFile(path.join(root, 'many.ts'), 'export default [() => "same", (value: number) => ({ value }), [1, 2]];');
  const result = await generateTemplates({ root, files: ['many.ts'] });

  assert.equal(result.documents.length, 1);
  assert.equal(await readFile(path.join(root, 'same.json'), 'utf8'), '{"value":2}');
});

test('invalid filenames and values leave templates intact and produce no JSON', async (t) => {
  const root = await fixture(t);

  for (const name of ['../outside', 'folder/file', 'folder\\file', 'CON', 'name.', '\u0000']) {
    await writeFile(path.join(root, 'many.ts'), `export default [() => ${JSON.stringify(name)}, () => ({}), [1]];`);
    await assert.rejects(generateTemplates({ root, files: ['many.ts'] }), /portable basename/);
  }

  for (const value of ['{ value: BigInt(1) }', '(() => { const value = {}; value.self = value; return value; })()']) {
    await writeFile(path.join(root, 'value.ts'), `export default ${value};`);
    await assert.rejects(generateTemplates({ root, files: ['value.ts'] }), /JSON|BigInt|circular/i);
  }

  await writeFile(path.join(root, 'value.ts'), 'export const value = 1;');
  await assert.rejects(generateTemplates({ root, files: ['value.ts'] }), /must export default/);
  assert.deepEqual(await readdir(root), ['many.ts', 'value.ts']);
});

test('default export shapes and JSON serialization follow the documented object and tuple forms', async (t) => {
  const root = await fixture(t);

  for (const value of ['null', '7', '"text"', '[1, 2]', '[() => "name", {}, [1]]', '[() => "name", () => ({}), {}]']) {
    await writeFile(path.join(root, 'shape.ts'), `export default ${value};`);
    await assert.rejects(generateTemplates({ root, files: ['shape.ts'] }), /Unsupported template|Invalid default export array/);
  }

  await writeFile(path.join(root, 'shape.ts'), 'export default { absent: undefined, value: Number.NaN, list: [, 1] };');
  await generateTemplates({ root, files: ['shape.ts'] });
  assert.equal(await readFile(path.join(root, 'shape.json'), 'utf8'), '{"value":null,"list":[null,1]}');
});

test('ordinary imported code runs before the plain default export is emitted', async (t) => {
  const root = await fixture(t);

  await writeFile(path.join(root, 'shared.ts'), 'export async function calculate(value: number) { return value * 2; }');
  await writeFile(path.join(root, 'value.ts'), `
    import { calculate } from './shared.ts';
    const values = await Promise.all([1, 2].map(calculate));
    export default { values };
  `);
  const result = await generateTemplates({ root, files: ['value.ts'] });

  assert.deepEqual(result.documents[0].value, { values: [2, 4] });
});

test('cancellation during validation publishes nothing', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();

  await writeFile(path.join(root, 'value.ts'), 'export default { value: 1 };');
  await assert.rejects(generateTemplates({
    root,
    files: ['value.ts'],
    signal: controller.signal,
    validate() {
      controller.abort(new Error('cancelled generator'));
    },
  }), /cancelled generator/);
  assert.deepEqual(await readdir(root), ['value.ts']);
});

test('runner generates named behavior and resource packs, preserving authored templates and script files', async (t) => {
  const { project, config, configPath } = await projectFor(t);

  config.bedrockCore.profiles.default.stages.generator = { types: false, pretty: { indent: 'space', size: 2 } };
  await mkdir(path.join(project, 'packs/gameplay/data'));
  await mkdir(path.join(project, 'shared'));
  await writeFile(path.join(project, 'shared/value.json'), '{"value":11}');
  await writeFile(path.join(project, 'packs/gameplay/data/settings.ts'), `import data from '../../../shared/value.json'; export default data;`);
  await writeFile(path.join(project, 'packs/gameplay/data/settings.json'), '{"authored":true}');
  await writeFile(path.join(project, 'packs/gameplay/data/types.d.ts'), 'declare const example: string;');
  await writeFile(path.join(project, 'packs/visuals/content.ts'), 'export default { resource: true };');
  await writeFile(path.join(project, 'packs/gameplay/scripts/custom.js'), 'export const custom = true;');
  await writeFile(path.join(project, 'packs/gameplay/scripts/main.ts'), `import settings from '../data/settings.json'; export const value = settings.value;`);
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });
  const executable = path.join(project, 'verify.mjs');

  await writeFile(executable, await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js')));
  assert.equal((await import(pathToFileURL(executable).href)).value, 11);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'content.json'), 'utf8')), { resource: true });
  assert.deepEqual(result.artifacts.filter(artifact => artifact.id.startsWith('generator:')).map(artifact => artifact.id).sort(), ['generator:gameplay:data/settings.json', 'generator:visuals:content.json']);
  assert.equal(result.dependencies.includes(path.join(project, 'shared/value.json')), true);
  assert.equal(await readFile(path.join(result.outputPaths.gameplay, 'scripts/custom.js'), 'utf8'), 'export const custom = true;');
  await assert.rejects(readFile(path.join(result.outputPaths.gameplay, 'data/settings.ts')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(project, 'packs/gameplay/data/settings.ts'), 'utf8'), /export default/);
  assert.equal(await readFile(path.join(project, 'packs/gameplay/data/settings.json'), 'utf8'), '{"authored":true}');
  assert.match(await readFile(path.join(project, 'packs/visuals/content.ts'), 'utf8'), /export default/);
});

test('generator selection supports a resource-only project and always protects scripts and declarations', async (t) => {
  const { project, config, configPath } = await projectFor(t);

  delete config.packs.gameplay;
  delete config.bedrockCore.profiles.default.export.gameplay;
  config.bedrockCore.profiles.default.stages = { generator: { types: false, include: 'packs/visuals/**/*.ts', exclude: '**/helper.ts' } };
  await mkdir(path.join(project, 'packs/visuals/scripts'));
  await writeFile(path.join(project, 'packs/visuals/selected.ts'), 'export default { selected: true };');
  await writeFile(path.join(project, 'packs/visuals/helper.ts'), 'export const helper = true;');
  await writeFile(path.join(project, 'packs/visuals/declarations.d.ts'), 'declare const types: true;');
  await writeFile(path.join(project, 'packs/visuals/scripts/ignored.ts'), 'export const script = true;');
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });

  assert.equal(result.packs.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'selected.json'), 'utf8')), { selected: true });
  assert.match(await readFile(path.join(result.outputPaths.visuals, 'helper.ts'), 'utf8'), /export const/);
  assert.match(await readFile(path.join(result.outputPaths.visuals, 'scripts/ignored.ts'), 'utf8'), /export const/);
});

test('a generator can consume an earlier hook artifact and feed the bundler through artifact IDs', async (t) => {
  const { project, config, configPath } = await projectFor(t);

  await writeFile(path.join(project, 'packs/gameplay/settings.ts'), `import value from '@bedrock-core/generated/input'; export default { value: value.count * 2 };`);
  await writeFile(path.join(project, 'packs/gameplay/scripts/main.ts'), `import settings from '@bedrock-core/generated/settings'; export const value = settings.value;`);
  await writeFile(path.join(project, 'generate.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const file = path.join(context.generatedDir, 'input.json');
      await writeFile(file, '{"count":4}');
      await context.registerArtifact('input', file);
    }
  `);
  config.bedrockCore.plugins = { input: { module: './generate.ts' } };
  const profile = config.bedrockCore.profiles.default;

  profile.steps = [{ plugin: 'input', before: 'generator' }];
  profile.stages.generator = { types: false, generatedImports: { '@bedrock-core/generated/input': 'input' } };
  profile.stages.bundler.generatedImports = { '@bedrock-core/generated/settings': 'generator:gameplay:settings.json' };
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });
  const executable = path.join(project, 'verify.mjs');

  await writeFile(executable, await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js')));
  assert.equal((await import(pathToFileURL(executable).href)).value, 8);
});

test('generator failures retain the last export and reject selections outside packs', async (t) => {
  const { project, config, configPath } = await projectFor(t);

  config.bedrockCore.profiles.default.stages.generator = { types: false };
  const source = path.join(project, 'packs/gameplay/settings.ts');

  await writeFile(source, 'export default { value: 1 };');
  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  const output = path.join(project, 'dist/gameplay/settings.json');
  const previous = await readFile(output, 'utf8');

  await writeFile(source, 'throw new Error("invalid template"); export default {};');
  await assert.rejects(runBuild({ configPath, logger: {} }), /invalid template/);
  assert.equal(await readFile(output, 'utf8'), previous);
  assert.match(await readFile(source, 'utf8'), /invalid template/);
  config.bedrockCore.profiles.default.stages.generator = { types: false, include: ['external.ts'] };
  await writeFile(path.join(project, 'external.ts'), 'export default {};');
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runBuild({ configPath, logger: {} }), /inside configured packs/);
  assert.equal(await readFile(output, 'utf8'), previous);
});

test('generator settings schema rejects malformed selectors, formatting and unknown fields', () => {
  const config = {
    type: 'minecraftBedrock', name: 'Generator schema', authors: [], targetVersion: '1.26.50',
    namespace: 'generator_schema', worlds: [], packs: { visuals: './pack' },
    bedrockCore: { formatVersion: '1.0.0', profiles: { default: { stages: {} } } },
  };

  for (const settings of [{ include: '' }, { exclude: [' '] }, { pretty: true }, { pretty: { size: 0 } }, { generatedImports: { input: ' ' } }, { types: 'yes' }, { strict: 'yes' }, { maxAgeHours: -1 }, { unknown: true }]) {
    config.bedrockCore.profiles.default.stages.generator = settings;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }

  config.bedrockCore.profiles.default.stages.generator = { include: 'packs/**/*.ts', exclude: [], pretty: { indent: 'space', size: 12 }, types: false, typesDir: null, schemaVersion: 'latest', strict: false, typePrefix: 'Mc', maxAgeHours: 24 };
  validateConfig(config);
});
