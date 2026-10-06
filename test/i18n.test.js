import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { compileI18n, parseLang } from '../packages/i18n/src/index.ts';
import { runBuild } from '../src/run.ts';
import { validateConfig } from '../src/config.ts';
import { projectFor } from '../test-support/project.js';
import { translationsFor, compileOptions, put, english, czech } from '../test-support/i18n.js';
import { manifestFor } from '../test-support/manifest.js';

const textAt = (root, file) => readFile(path.join(root, file), 'utf8');

test('default exports emit compatible positional language entries, runtime templates and metadata aliases', async (t) => {
  const project = await translationsFor(t);

  await put(project.project, 'packs/visuals/texts/en_US.lang', 'manual.line=Back to \r\nmanual.equals=a=b\r\n');
  await put(project.project, 'packs/gameplay/texts/en_US.lang', 'manual.bp=Behavior\n');
  await put(project.project, 'packs/visuals/texts/languages.json', '["fr_FR"]');
  const result = await compileI18n(compileOptions(project));
  const rp = parseLang(await textAt(project.project, 'packs/visuals/texts/en_US.lang'));
  const bp = parseLang(await textAt(project.project, 'packs/gameplay/texts/en_US.lang'));
  const localized = parseLang(await textAt(project.project, 'packs/visuals/texts/cs_CZ.lang'));

  assert.equal(rp['flow_test.shop.bought'], 'Bought %1$s for %2$s; %1$s.');
  assert.equal(localized['flow_test.shop.bought'], 'Za %2$s koupen %1$s; %1$s.');
  assert.equal(localized['flow_test.shop.stock_few'], '%1$s kusy');
  assert.equal(rp['flow_test.shop.intro'], 'Welcome to Shop.');
  assert.equal(rp['manual.line'], 'Back to ');
  assert.deepEqual(bp, { 'manual.bp': 'Behavior', 'pack.description': 'Sells items', 'pack.name': 'Shop' });
  assert.deepEqual(result.bundle, {
    namespace: 'flow_test', defaultLocale: 'en_US', libs: [],
    args: {
      'shop.bought': ['item', 'price'], 'shop.stock_few': ['count'],
      'shop.stock_one': ['count'], 'shop.stock_other': ['count'],
    },
    extra: { en_US: { 'manual.bp': 'Behavior', 'manual.equals': 'a=b', 'manual.line': 'Back to ' } },
    locales: {
      cs_CZ: {
        'meta.name': 'Obchod', 'meta.description': 'Prodává předměty', 'shop.title': 'Obchod',
        'shop.bought': czech.shop.bought, 'shop.intro': 'Vítejte: Obchod.',
        'shop.stock_one': czech.shop.stock_one, 'shop.stock_other': czech.shop.stock_other,
        'shop.stock_few': czech.shop.stock_few,
      },
      en_US: { 'meta.name': 'Shop', 'meta.description': 'Sells items', 'shop.title': 'Shop',
        'shop.bought': english.shop.bought, 'shop.intro': 'Welcome to Shop.',
        'shop.stock_one': english.shop.stock_one, 'shop.stock_other': english.shop.stock_other },
    },
  });
  assert.deepEqual(JSON.parse(await textAt(project.project, 'packs/visuals/texts/languages.json')), ['fr_FR', 'cs_CZ', 'en_US']);
  const before = await textAt(project.project, 'packs/visuals/texts/en_US.lang');
  const dts = result.declarations[0];
  const mtime = (await stat(dts)).mtimeMs;

  await compileI18n(compileOptions(project));
  assert.equal(await textAt(project.project, 'packs/visuals/texts/en_US.lang'), before);
  assert.equal((await stat(dts)).mtimeMs, mtime);
  assert.deepEqual(result.inputs.filter(file => file.endsWith('.ts')).map(file => path.basename(file)).sort(), ['cs_CZ.ts', 'en_US.ts']);
});

test('resources support relative TS/JSON imports, Node modules and asynchronous evaluation, reloaded every build', async (t) => {
  const project = await projectFor(t);
  const helper = await put(project.project, 'shared/name.ts', 'export const name = "First" as const;');
  const data = await put(project.project, 'shared/label.json', '{"label":"Store"}');

  await put(project.project, 'i18n/en_US.ts', `
    import { name } from '../shared/name.ts';
    import data from '../shared/label.json';
    import path from 'node:path';
    export default await Promise.resolve({ meta: { name }, shop: { title: path.basename(data.label) } });
  `);
  const first = await compileI18n(compileOptions(project));

  assert.equal(first.bundle.locales.en_US['meta.name'], 'First');
  assert.equal(first.bundle.locales.en_US['shop.title'], 'Store');
  assert.ok(first.inputs.includes(helper));
  assert.ok(first.inputs.includes(data));
  await put(project.project, 'shared/name.ts', 'export const name = "Second" as const;');
  const second = await compileI18n(compileOptions(project));

  assert.equal(second.bundle.locales.en_US['meta.name'], 'Second');
});

test('strict parity failures leave all outputs intact; loose parity fills missing keys and drops extras', async (t) => {
  const project = await translationsFor(t);
  const before = await compileI18n(compileOptions(project));
  const oldBundle = await readFile(before.bundlePath, 'utf8');
  const oldLang = await textAt(project.project, 'packs/visuals/texts/cs_CZ.lang');

  await put(project.project, 'i18n/cs_CZ.ts', 'export default { extra: "Discard" };');
  await assert.rejects(compileI18n(compileOptions(project)), /keys missing[\s\S]*no en_US counterpart/);
  assert.equal(await readFile(before.bundlePath, 'utf8'), oldBundle);
  assert.equal(await textAt(project.project, 'packs/visuals/texts/cs_CZ.lang'), oldLang);
  const result = await compileI18n({ ...compileOptions(project), strict: false });

  assert.deepEqual(result.bundle.locales.cs_CZ, result.bundle.locales.en_US);
  assert.equal(result.warnings.length, 2);
});

for (const [name, value, expected] of [
  ['non-string leaf', { key: 123 }, /values must be strings/],
  ['invalid key', { 'bad.key': 'Value' }, /segment/],
  ['newline', { key: 'Line\nBreak' }, /one line/],
  ['missing plural fallback', { items_one: '{{count}} item' }, /requires its _other/],
  ['unknown nesting', { key: '$t(missing)' }, /unknown key/],
  ['nesting cycle', { first: '$t(second)', second: '$t(first)' }, /circular/],
]) {
  test(`reject ${name} before creating generated files`, async (t) => {
    const project = await projectFor(t);

    await put(project.project, 'i18n/en_US.ts', `export default ${JSON.stringify(value)};`);
    await assert.rejects(compileI18n(compileOptions(project)), expected);
    await assert.rejects(access(path.join(project.project, 'packs/visuals/texts')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(project.project, '.bedrock-core/generated/i18n')), { code: 'ENOENT' });
  });
}

test('interpolation drift and locale-only plural variable drift fail before positional output', async (t) => {
  const project = await translationsFor(t);
  const changed = structuredClone(czech);

  changed.shop.bought = 'Bought {{other}}';
  changed.shop.stock_few = '{{amount}}';
  await put(project.project, 'i18n/cs_CZ.ts', `export default ${JSON.stringify(changed)};`);
  await assert.rejects(compileI18n(compileOptions(project)), /shop.bought[\s\S]*shop.stock_few/);
  await assert.rejects(compileI18n({ ...compileOptions(project), strict: false }), /not in the recorded order/);
});

test('no resources is a no-op and the default locale remains required with strict disabled', async (t) => {
  const project = await projectFor(t);
  const result = await compileI18n(compileOptions(project));

  assert.equal(result.bundle, undefined);
  assert.deepEqual(result.files, []);
  await put(project.project, 'i18n/cs_CZ.js', 'export default { title: "Obchod" };');
  await assert.rejects(compileI18n({ ...compileOptions(project), strict: false }), /en_US has no resource module/);
});

test('removing metadata clears only generated BP aliases and preserves manual text', async (t) => {
  const project = await translationsFor(t);

  await put(project.project, 'packs/gameplay/texts/en_US.lang', 'manual.line=Keep me\n');
  await compileI18n(compileOptions(project));
  await put(project.project, 'i18n/en_US.ts', 'export default { shop: { title: "Shop" } } as const;');
  await rm(path.join(project.project, 'i18n/cs_CZ.ts'));
  await compileI18n(compileOptions(project));
  assert.deepEqual(parseLang(await textAt(project.project, 'packs/gameplay/texts/en_US.lang')), { 'manual.line': 'Keep me' });
});

test('transitive library discovery merges shared namespaces, applies overrides and falls back across locales', async (t) => {
  const project = await translationsFor(t);

  await put(project.project, 'package.json', '{"type":"module","devDependencies":{"umbrella":"1","second":"1"}}');
  await put(project.project, 'node_modules/umbrella/package.json', '{"dependencies":{"first":"1"},"devDependencies":{"ignored":"1"}}');

  for (const [name, value] of [['first', { welcome: 'Hello {{name}}' }], ['second', { title: 'Library' }]]) {
    await put(project.project, `node_modules/${name}/package.json`, JSON.stringify({
      type: 'module', bedrockCore: { i18n: { dir: './src/i18n', namespace: 'core' } },
      exports: { './i18n/*': './src/i18n/*.ts' },
    }));
    await put(project.project, `node_modules/${name}/src/i18n/en_US.ts`, `export default ${JSON.stringify(value)} as const;`);
  }

  await put(project.project, 'node_modules/ignored/package.json', '{"bedrockCore":{"i18n":{"dir":"i18n","namespace":"ignored"}}}');
  await put(project.project, 'node_modules/ignored/i18n/en_US.ts', 'export default { title: "Ignored" };');
  await put(project.project, 'i18n/en_US.ts', `export default ${JSON.stringify({ ...english, core: { welcome: 'Hi {{name}}' } })} as const;`);
  const result = await compileI18n(compileOptions(project));

  assert.deepEqual(result.bundle.libs, ['core']);
  assert.equal(result.bundle.locales.en_US['core.welcome'], 'Hi {{name}}');
  assert.equal(result.bundle.locales.cs_CZ['core.welcome'], 'Hello {{name}}');
  assert.equal(result.bundle.locales.cs_CZ['core.title'], 'Library');
  assert.equal(parseLang(await textAt(project.project, 'packs/visuals/texts/en_US.lang'))['core.welcome'], 'Hi %1$s');
  assert.ok(result.inputs.includes(path.join(project.project, 'node_modules/umbrella/package.json')));
  const dts = await readFile(result.declarations[0], 'utf8');

  assert.match(dts, /Omit<Own, 'core'>/);
  assert.match(dts, /typeof import\('first\/i18n\/en_US'\).default/);
  assert.doesNotMatch(dts, /ignored/);
  await put(project.project, 'node_modules/second/src/i18n/en_US.ts', 'export default { welcome: "Conflict" };');
  await assert.rejects(compileI18n({ ...compileOptions(project), strict: false }), /different values by first, second/);
});

test('vanilla keys are typed completely, bundled only when referenced, and emitted only for overrides', async (t) => {
  const project = await translationsFor(t);
  const requests = [];

  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);

    return url.includes('en_US')
      ? new Response('item.apple.name=Apple\nitem.apple=Apple group\nunused.key=Unused\n')
      : new Response('', { status: 404 });
  });
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'const key = "vanilla.item.apple.name";');
  await put(project.project, 'i18n/en_US.ts', `export default ${JSON.stringify({ ...english, vanilla: { item: { apple: { name: 'Snack' } } } })} as const;`);
  const options = { ...compileOptions(project), vanilla: true, vanillaLangUrlTemplate: 'https://example.invalid/{locale}.lang' };
  const result = await compileI18n(options);
  const rp = parseLang(await textAt(project.project, 'packs/visuals/texts/en_US.lang'));
  const declaration = await readFile(result.declarations[1], 'utf8');

  assert.equal(rp['item.apple.name'], 'Snack');
  assert.equal(rp['unused.key'], undefined);
  assert.equal(result.bundle.locales.en_US['vanilla.item.apple.name'], 'Snack');
  assert.equal(result.bundle.locales.cs_CZ['vanilla.item.apple.name'], 'Apple');
  assert.equal(result.bundle.locales.en_US['vanilla.unused.key'], undefined);
  assert.match(declaration, /readonly 'unused':/);
  assert.match(declaration, /} & string;/);
  assert.doesNotMatch(declaration, /\t/);
  assert.equal(result.warnings.length, 1);
  await compileI18n(options);
  assert.equal(requests.filter(url => url.includes('en_US')).length, 1);
});

test('generated declarations retain literal resources and interpolation variables under strict NodeNext', async (t) => {
  const project = await translationsFor(t);

  await put(project.project, 'package.json', '{"type":"module"}');
  const result = await compileI18n(compileOptions(project));
  const consumer = await put(project.project, 'check.ts', `
    import bundle from '@bedrock-core/generated/i18n';
    type Resource = NonNullable<typeof bundle.resources>;
    const template: Resource['shop']['bought'] = 'Bought {{item}} for {{price}}; {{item}}.';
    // @ts-expect-error Unknown keys are rejected.
    type Missing = Resource['shop']['absent'];
    // @ts-expect-error Literal template types must retain interpolation names.
    const wrong: Resource['shop']['bought'] = 'Any other string';
    const locale: 'en_US' = bundle.defaultLocale;
    void template; void locale; void wrong;
  `);
  const program = ts.createProgram([consumer, ...result.declarations], {
    strict: true, noEmit: true, types: [], allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  assert.doesNotMatch(await readFile(result.declarations[0], 'utf8'), /\t/);
});

test('pipeline resolves generated imports automatically, honors arbitrary pack counts, and preserves previous exports on errors', async (t) => {
  const project = await translationsFor(t);

  project.config.packs.extraVisuals = './packs/extra-visuals';
  project.config.bedrockCore.profiles.default.export.extraVisuals = './dist/extraVisuals';
  await put(project.project, 'packs/extra-visuals/manifest.json', JSON.stringify(manifestFor('resources')));
  project.config.bedrockCore.profiles.default.stages = {
    i18n: true,
    bundler: { debug: true },
  };
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import bundle from "@bedrock-core/generated/i18n"; export default bundle;');
  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.ok(result.artifacts.some(artifact => artifact.id === 'i18n:bundle' && artifact.owner === 'i18n'));
  assert.equal(result.artifacts.find(artifact => artifact.id === 'i18n:bundle').importAs, '@bedrock-core/generated/i18n');
  assert.ok(result.artifacts.some(artifact => artifact.id === 'i18n:extraVisuals:texts/en_US.lang'));
  assert.ok(result.dependencies.includes(path.join(project.project, 'i18n/en_US.ts')));
  assert.match(await textAt(result.outputPaths.gameplay, 'scripts/main.js'), /flow_test/);
  assert.equal(await textAt(result.outputPaths.extraVisuals, 'texts/en_US.lang'), await textAt(result.outputPaths.visuals, 'texts/en_US.lang'));
  await assert.rejects(access(path.join(project.project, 'packs/visuals/texts')), { code: 'ENOENT' });
  const output = await textAt(result.outputPaths.visuals, 'texts/en_US.lang');

  await put(project.project, 'i18n/en_US.ts', 'export default { bad: "$t(missing)" };');
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /i18n compilation failed/);
  assert.equal(await textAt(result.outputPaths.visuals, 'texts/en_US.lang'), output);
});

for (const [id, kind] of [['gameplay', 'behavior'], ['visuals', 'resource']]) {
  test(`i18n works with ${kind} packs only`, async (t) => {
    const project = await translationsFor(t);

    project.config.packs = { [id]: project.config.packs[id] };
    project.config.bedrockCore.profiles.default.export = { [id]: `./dist/${id}` };
    project.config.bedrockCore.profiles.default.stages = { i18n: true, bundler: false };

    if (kind === 'behavior') {
      await put(project.project, 'packs/gameplay/scripts/main.js', 'export {};');
    }

    await put(project.project, 'config.json', JSON.stringify(project.config));
    const result = await runBuild({ configPath: project.configPath, logger: {} });
    const lang = parseLang(await textAt(result.outputPaths[id], 'texts/en_US.lang'));

    assert.equal(lang['pack.name'], 'Shop');
    assert.equal(lang['flow_test.shop.title'], kind === 'resource' ? 'Shop' : undefined);
  });
}

test('i18n schema validates settings and rejects source paths outside staging', async (t) => {
  const project = await translationsFor(t);

  for (const settings of [{ strict: 'yes' }, { defaultLocale: 'english' }, { namespace: 'Upper' }, { cacheMaxAgeHours: -1 }, { typo: true }]) {
    project.config.bedrockCore.profiles.default.stages = { i18n: settings };
    assert.throws(() => validateConfig(project.config), /Invalid project configuration/);
  }

  project.config.bedrockCore.profiles.default.stages = { i18n: { sourceDir: '../outside' } };
  await put(project.project, 'config.json', JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /inside the project/);
});

test('a disabled i18n producer reports the missing import without using an old generated file', async (t) => {
  const project = await translationsFor(t);

  project.config.bedrockCore.profiles.default.stages = { i18n: true, bundler: true };
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import bundle from "@bedrock-core/generated/i18n"; export default bundle;');
  await put(project.project, 'config.json', JSON.stringify(project.config));
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const previous = await textAt(first.outputPaths.gameplay, 'scripts/main.js');

  assert.ok(await access(path.join(project.project, '.bedrock-core/generated/i18n/i18n.generated.d.ts')).then(() => true));
  project.config.bedrockCore.profiles.default.stages = { i18n: false, bundler: true };
  await put(project.project, 'config.json', JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Missing generated import[\s\S]*enable its producing stage/);
  assert.equal(await textAt(first.outputPaths.gameplay, 'scripts/main.js'), previous);
});
