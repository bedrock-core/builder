import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import ts from 'typescript';
import { projectFor, put } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { installI18nRuntime } from '../test-support/i18n-runtime.js';
import { runBuild } from '../src/run.ts';

async function fixture(t) {
  const project = await projectFor(t);

  await installI18nRuntime(project.project);
  await put(project.project, 'package.json', JSON.stringify({ type: 'module', dependencies: { '@bedrock-core/i18n': '*', 'fixture-library': '*' } }));
  await put(project.project, 'node_modules/fixture-library/package.json', JSON.stringify({
    name: 'fixture-library', type: 'module', exports: { './i18n/*': './i18n/*.ts' },
    bedrockCore: { i18n: { dir: 'i18n', namespace: 'core' } },
  }));
  await put(project.project, 'node_modules/fixture-library/i18n/en_US.ts', 'export default { button: { label: "Library button" } } as const;');
  await put(project.project, 'packs/gameplay/i18n/en_US.ts', 'export default { pack: { name: "Source addon", description: "Source description" }, welcome: "Welcome {{name}}", title: "English" } as const;');
  await put(project.project, 'packs/gameplay/i18n/es_ES.ts', 'export default { pack: { name: "Complemento", description: "Descripcion" }, welcome: "Hola {{name}}", title: "Espanol" } as const;');
  await put(project.project, 'packs/gameplay/i18n/index.ts', `
    import { createI18n } from '@bedrock-core/i18n';
    import en_US from './en_US';
    import es_ES from './es_ES';
    export const i18n = createI18n({ en_US, es_ES });
  `);
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { i18n } from "../i18n";');
  project.config.bedrockCore.profiles.default.stages = { 'generator': false, 'guides': false, 'ui-compiler': false };
  await put(project.project, 'config.json', JSON.stringify(project.config));

  return { ...project, options: { configPath: project.configPath, logger: {} } };
}

test('authored locale-object instances receive compiled libraries and owned namespaces without source changes', async (t) => {
  const project = await fixture(t);
  const sourceFile = path.join(project.project, 'packs/gameplay/i18n/index.ts');
  const source = await readFile(sourceFile, 'utf8');
  const first = await runBuild(project.options);
  const { i18n } = await import(pathToFileURL(path.join(first.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.equal(i18n.key($ => $.title), 'flow_test.title');
  assert.equal(i18n.t($ => $.welcome, { name: 'Alex' }), 'Welcome Alex');
  assert.equal(i18n.forLocale('es_ES').t($ => $.welcome, { name: 'Alex' }), 'Hola Alex');
  assert.equal(i18n.t($ => $.core.button.label), 'Library button');
  assert.equal(i18n.key($ => $.core.button.label), 'core.button.label');
  assert.deepEqual(i18n.raw($ => $.welcome, { name: 'Alex' }), { translate: 'flow_test.welcome', with: ['Alex'] });
  assert.equal(await readFile(sourceFile, 'utf8'), source);
  const language = await readFile(path.join(first.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');

  assert.match(language, /flow_test.title=English/);
  assert.match(language, /core.button.label=Library button/);
  const warm = await runBuild(project.options);

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  await put(project.project, 'packs/gameplay/i18n/en_US.ts', 'export default { pack: { name: "Source addon", description: "Source description" }, welcome: "Hello {{name}}", title: "Changed" } as const;');
  const changed = await runBuild(project.options);
  const updated = await import(pathToFileURL(path.join(changed.outputPaths.gameplay, 'scripts/main.js')).href + '?changed');

  assert.equal(updated.i18n.t($ => $.title), 'Changed');
  assert.equal(updated.i18n.t($ => $.welcome, { name: 'Alex' }), 'Hello Alex');
});

test('direct instance declarations retain own literal keys and compiler-provided library selectors', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/i18n/en_US.ts', 'export default { pack: { name: "Source addon", description: "Source description" }, welcome: "Welcome {{name}}", title: "English", core: { button: { label: "Authored button" } } } as const;');
  await runBuild(project.options);
  const consumer = await put(project.project, 'check.ts', `
    import { i18n } from './packs/gameplay/i18n';
    i18n.t($ => $.welcome, { name: 'Alex' });
    i18n.key($ => $.core.button.label);
    // @ts-expect-error Unknown own keys are rejected.
    i18n.key($ => $.missing);
  `);
  const declaration = path.join(project.project, '.bedrock-core/generated/i18n/gameplay/i18n.generated.d.ts');
  const program = ts.createProgram([consumer, declaration], {
    strict: true, noEmit: true, types: [], skipLibCheck: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item => `${item.file?.fileName}:${item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : ''} ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`), []);
});

test('direct instances preserve vanilla keys and authored language passthrough for measurement', async (t) => {
  const project = await fixture(t);
  const server = createServer((_request, response) => response.end('item.apple.name=Apple\n'));

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  project.config.bedrockCore.profiles.default.stages.i18n = {
    vanilla: true,
    vanillaLangUrlTemplate: `http://127.0.0.1:${server.address().port}/{locale}.lang`,
  };
  await put(project.project, 'config.json', JSON.stringify(project.config));
  await put(project.project, 'packs/visuals/texts/en_US.lang', 'external.caption=External caption\n');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `
    import { i18n } from '../i18n';
    export { i18n };
    export { apple } from '../UI/vanilla.mts';
  `);
  await put(project.project, 'packs/gameplay/UI/vanilla.mts', `
    import { i18n } from '../i18n';
    export const apple = i18n.key($ => $.vanilla.item.apple.name);
  `);
  const result = await runBuild(project.options);
  const module = await import(pathToFileURL(path.join(result.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.equal(module.apple, 'item.apple.name');
  assert.equal(module.i18n.resolve('item.apple.name'), 'Apple');
  assert.equal(module.i18n.resolve('external.caption'), 'External caption');
});

test('capturing an instance preserves public pure helpers imported by locale resources', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/i18n/en_US.ts', `
    import { overlay } from '@bedrock-core/i18n';
    export default overlay({ pack: { name: 'Addon', description: 'Description' }, title: 'Initial', welcome: 'Welcome {{name}}' } as const, { title: 'Overlaid' } as const);
  `);
  const result = await runBuild(project.options);
  const module = await import(pathToFileURL(path.join(result.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.equal(module.i18n.t($ => $.title), 'Overlaid');
});

test('inline locale maps and aliased factories are compiled and owner namespace mismatches fail', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/i18n/index.ts', `
    import { createI18n as translations } from '@bedrock-core/i18n';
    import { greeting } from './words';
    export default translations({ en_US: { hello: greeting } });
  `);
  await put(project.project, 'packs/gameplay/i18n/words.ts', 'export const greeting = "Hello";');
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { default as i18n } from "../i18n";');
  const result = await runBuild(project.options);
  const { i18n } = await import(pathToFileURL(path.join(result.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.equal(i18n.key($ => $.hello), 'flow_test.hello');
  await put(project.project, 'packs/gameplay/i18n/words.ts', 'export const greeting = "Edited helper";');
  const changed = await runBuild(project.options);
  const changedModule = await import(pathToFileURL(path.join(changed.outputPaths.gameplay, 'scripts/main.js')).href + '?helper');

  assert.equal(changedModule.i18n.t($ => $.hello), 'Edited helper');
  await put(project.project, 'packs/gameplay/i18n/index.ts', `
    import { createI18n } from '@bedrock-core/i18n';
    export const i18n = createI18n({ en_US: { hello: 'Hello' } }, { namespace: 'wrong_owner' });
  `);
  await assert.rejects(runBuild(project.options), /owning manifest namespace/);
});

test('owners with different default locales share stable library declarations and retain their own fallback', async (t) => {
  const project = await fixture(t);
  const secondary = manifestFor('script', 'scripts/main.ts');

  secondary.namespace = 'flow_secondary';
  secondary.dependencies = [{ uuid: project.resources.header.uuid }];
  project.config.packs.secondary = './packs/secondary';
  project.config.bedrockCore.profiles.default.export.secondary = './dist/secondary';
  await put(project.project, 'node_modules/fixture-library/i18n/es_ES.ts', 'export default { button: { label: "Biblioteca" } } as const;');
  await put(project.project, 'packs/secondary/manifest.json', JSON.stringify(secondary));
  await put(project.project, 'packs/secondary/i18n/index.ts', `
    import { createI18n } from '@bedrock-core/i18n';
    export const i18n = createI18n({ es_ES: { title: 'Segundo' } }, { defaultLocale: 'es_ES' });
  `);
  await put(project.project, 'packs/secondary/scripts/main.ts', 'export { i18n } from "../i18n";');
  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild(project.options);
  const module = await import(pathToFileURL(path.join(result.outputPaths.secondary, 'scripts/main.js')).href);

  assert.equal(module.i18n.locale, 'es_ES');
  assert.equal(module.i18n.t($ => $.title), 'Segundo');
  assert.equal(module.i18n.t($ => $.core.button.label), 'Biblioteca');
  assert.equal(module.i18n.key($ => $.title), 'flow_secondary.title');
  const consumer = await put(project.project, 'check.ts', `
    import { i18n as first } from './packs/gameplay/i18n';
    import { i18n as second } from './packs/secondary/i18n';
    first.t($ => $.core.button.label);
    second.t($ => $.core.button.label);
    // @ts-expect-error One owner's resource shape cannot expose another owner's key.
    second.t($ => $.welcome, { name: 'Alex' });
  `);
  const declarations = ['gameplay', 'secondary'].map(owner => path.join(project.project, `.bedrock-core/generated/i18n/${owner}/i18n.generated.d.ts`));
  const program = ts.createProgram([consumer, ...declarations], {
    strict: true, noEmit: true, types: [], skipLibCheck: false,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item => `${item.file?.fileName}:${item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : ''} ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`), []);
});
