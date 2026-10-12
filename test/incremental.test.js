import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { put, translationsFor, english } from '../test-support/i18n.js';

const status = (result, id) => result.compilations.find(file => file.id === id)?.status;
const optionsFor = project => ({ configPath: project.configPath, logger: {} });

test('script entries rebuild only for their own transitive dependencies', async (t) => {
  const project = await projectFor(t);
  const options = optionsFor(project);

  await put(project.project, 'shared/value.ts', 'export const shared = 10;');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import { shared } from '../../../shared/value.ts'; export const value = shared + 1;`);
  await put(project.project, 'packs/other/manifest.json', JSON.stringify(manifestFor('script')));
  await put(project.project, 'packs/other/scripts/main.ts', `import { shared } from '../../../shared/value.ts'; export const value = shared + 2;`);
  project.config.packs.other = './packs/other';
  project.config.bedrockCore.profiles.default.export.other = './dist/other';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await runBuild(options);

  const unchanged = await runBuild(options);

  assert.equal(status(unchanged, 'bundler/gameplay:scripts/main.js'), 'cached');
  assert.equal(status(unchanged, 'bundler/other:scripts/main.js'), 'cached');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import { shared } from '../../../shared/value.ts'; export const value = shared + 3;`);
  const single = await runBuild(options);

  assert.equal(status(single, 'bundler/gameplay:scripts/main.js'), 'executed');
  assert.equal(status(single, 'bundler/other:scripts/main.js'), 'cached');
  await put(project.project, 'packs/visuals/asset.json', '{"value":50}');
  const resource = await runBuild(options);

  assert.equal(status(resource, 'bundler/gameplay:scripts/main.js'), 'cached');
  assert.equal(status(resource, 'bundler/other:scripts/main.js'), 'cached');
  assert.equal(await readFile(path.join(resource.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":50}');
  await put(project.project, 'shared/value.ts', 'export const shared = 20;');
  const shared = await runBuild(options);

  assert.equal(status(shared, 'bundler/gameplay:scripts/main.js'), 'executed');
  assert.equal(status(shared, 'bundler/other:scripts/main.js'), 'executed');
});

test('generator imports invalidate their template and only changed output invalidates its consumer', async (t) => {
  const project = await projectFor(t);
  const options = optionsFor(project);

  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'shared/data.json', '{"value":7}');
  await put(project.project, 'packs/gameplay/data/value.ts', `import data from '../../../shared/data.json'; export default { value: data.value };`);
  await put(project.project, 'packs/gameplay/data/other.ts', 'export default { unrelated: true };');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from '../data/value.json'; export const value = data.value;`);
  await runBuild(options);
  const unchanged = await runBuild(options);

  assert.equal(status(unchanged, 'generator/packs/gameplay/data/value.ts'), 'cached');
  assert.equal(status(unchanged, 'generator/packs/gameplay/data/other.ts'), 'cached');
  assert.equal(status(unchanged, 'bundler/gameplay:scripts/main.js'), 'cached');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from '../data/value.json'; export const value = data.value + 1;`);
  const script = await runBuild(options);

  assert.equal(status(script, 'generator/packs/gameplay/data/value.ts'), 'cached');
  assert.equal(status(script, 'generator/packs/gameplay/data/other.ts'), 'cached');
  assert.equal(status(script, 'bundler/gameplay:scripts/main.js'), 'executed');
  await put(project.project, 'shared/data.json', '{"value":8}');
  const dependency = await runBuild(options);

  assert.equal(status(dependency, 'generator/packs/gameplay/data/value.ts'), 'executed');
  assert.equal(status(dependency, 'generator/packs/gameplay/data/other.ts'), 'cached');
  assert.equal(status(dependency, 'bundler/gameplay:scripts/main.js'), 'executed');
  await put(project.project, 'packs/gameplay/data/value.ts', `import data from '../../../shared/data.json'; export default { value: data.value }; // same JSON`);
  const equivalent = await runBuild(options);

  assert.equal(status(equivalent, 'generator/packs/gameplay/data/value.ts'), 'executed');
  assert.equal(status(equivalent, 'bundler/gameplay:scripts/main.js'), 'cached');
  assert.deepEqual(JSON.parse(await readFile(path.join(equivalent.outputPaths.gameplay, 'data/value.json'), 'utf8')), { value: 8 });
  await rm(path.join(project.project, 'packs/gameplay/data/other.ts'));
  const removed = await runBuild(options);

  assert.equal(status(removed, 'generator/packs/gameplay/data/other.ts'), undefined);
  await assert.rejects(readFile(path.join(removed.outputPaths.gameplay, 'data/other.json')), { code: 'ENOENT' });
  await put(project.project, 'packs/gameplay/data/added.ts', 'export default { added: true };');
  const added = await runBuild(options);

  assert.equal(status(added, 'generator/packs/gameplay/data/added.ts'), 'executed');
  assert.equal(status(added, 'generator/packs/gameplay/data/value.ts'), 'cached');
});

test('plain Many callbacks and data-only TS imports cache without changing their exports', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'shared/items.ts', 'export const items = [{ name: "a", value: 3 }, { name: "b", value: 4 }] as const;');
  await put(project.project, 'packs/gameplay/data/many.ts', `
    import { items } from '../../../shared/items.ts';
    export default [(item) => item.name, (item) => ({ value: item.value }), items];
  `);
  await runBuild(optionsFor(project));
  const result = await runBuild(optionsFor(project));

  assert.equal(status(result, 'generator/packs/gameplay/data/many.ts'), 'cached');
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'data/a.json'), 'utf8')), { value: 3 });
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'data/b.json'), 'utf8')), { value: 4 });
});

test('Node environment imports and side-effect modules keep evaluating', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'packs/gameplay/data/environment.ts', `import process from 'node:process'; export default { value: process.env.BUILDER_INCREMENTAL_TEST };`);
  t.after(() => {
    delete process.env.BUILDER_INCREMENTAL_TEST;
  });
  process.env.BUILDER_INCREMENTAL_TEST = 'first';
  await runBuild(optionsFor(project));
  process.env.BUILDER_INCREMENTAL_TEST = 'second';
  const result = await runBuild(optionsFor(project));

  assert.equal(status(result, 'generator/packs/gameplay/data/environment.ts'), 'executed');
  assert.equal(status(result, 'generator/compiled:packs/gameplay/data/environment.ts'), 'cached');
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'data/environment.json'), 'utf8')), { value: 'second' });
});

test('output formatting and unrelated config changes reuse existing compiled modules', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'packs/gameplay/data/value.ts', 'export default { value: 5 };');
  await runBuild(optionsFor(project));
  await runBuild(optionsFor(project));
  project.config.namespace = 'other_namespace';
  project.config.bedrockCore.profiles.default.stages.generator.pretty = { indent: 'space', size: 2 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const formatted = await runBuild(optionsFor(project));

  assert.equal(status(formatted, 'generator/packs/gameplay/data/value.ts'), 'executed');
  assert.equal(status(formatted, 'generator/compiled:packs/gameplay/data/value.ts'), 'cached');
  assert.equal(status(formatted, 'bundler/gameplay:scripts/main.js'), 'cached');
  assert.equal(await readFile(path.join(formatted.outputPaths.gameplay, 'data/value.json'), 'utf8'), '{\n  "value": 5\n}\n');
  project.config.bedrockCore.profiles.default.stages.bundler.debug = false;
  await writeFile(project.configPath, JSON.stringify(project.config));
  const release = await runBuild(optionsFor(project));

  assert.equal(status(release, 'bundler/gameplay:scripts/main.js'), 'executed');
  await assert.rejects(readFile(path.join(release.outputPaths.gameplay, 'scripts/main.js.map')), { code: 'ENOENT' });
});

test('locales reuse compiled modules, evaluate runtime inputs and invalidate only imported helpers', async (t) => {
  const project = await translationsFor(t);

  project.config.bedrockCore.profiles.default.stages.i18n = { types: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'shared/title.ts', 'export const suffix = "A";');
  await put(project.project, 'packs/gameplay/i18n/en_US.ts', `
    import process from 'node:process';
    import { suffix } from '../../../shared/title.ts';
    const resource = ${JSON.stringify(english)};
    resource.shop.title += suffix + process.env.BUILDER_LOCALE_TEST;
    export default resource;
  `);
  t.after(() => {
    delete process.env.BUILDER_LOCALE_TEST;
  });
  process.env.BUILDER_LOCALE_TEST = 'first';
  await runBuild(optionsFor(project));
  process.env.BUILDER_LOCALE_TEST = 'second';
  const runtime = await runBuild(optionsFor(project));

  assert.equal(status(runtime, 'i18n/compiled:packs/gameplay/i18n/en_US.ts'), 'cached');
  assert.equal(status(runtime, 'i18n/compiled:packs/gameplay/i18n/cs_CZ.ts'), 'cached');
  assert.match(await readFile(path.join(runtime.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /flow_test.shop.title=ShopAsecond/);
  await put(project.project, 'shared/title.ts', 'export const suffix = "B";');
  const helper = await runBuild(optionsFor(project));

  assert.equal(status(helper, 'i18n/compiled:packs/gameplay/i18n/en_US.ts'), 'executed');
  assert.equal(status(helper, 'i18n/compiled:packs/gameplay/i18n/cs_CZ.ts'), 'cached');
  assert.equal(status(helper, 'bundler/gameplay:scripts/main.js'), 'cached');
  assert.match(await readFile(path.join(helper.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /flow_test.shop.title=ShopBsecond/);
});

test('profile cache false compiles runtime templates again without persistent records', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.cache = false;
  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'packs/gameplay/data/runtime.ts', 'export default { value: Math.random() };');
  await runBuild(optionsFor(project));
  const result = await runBuild(optionsFor(project));

  assert.equal(status(result, 'generator/compiled:packs/gameplay/data/runtime.ts'), 'executed');
  await assert.rejects(readFile(path.join(project.project, '.bedrock-core/cache/build')), { code: 'ENOENT' });
});

test('adding a resolution candidate or compiler config invalidates the affected bundle', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'packs/gameplay/scripts/main.ts', `export { value } from './helper';`);
  await put(project.project, 'packs/gameplay/scripts/helper.js', 'export const value = 1;');
  await runBuild(optionsFor(project));
  assert.equal(status(await runBuild(optionsFor(project)), 'bundler/gameplay:scripts/main.js'), 'cached');
  await put(project.project, 'packs/gameplay/scripts/helper.ts', 'export const value = 2;');
  const candidate = await runBuild(optionsFor(project));

  assert.equal(status(candidate, 'bundler/gameplay:scripts/main.js'), 'executed');
  assert.match(await readFile(path.join(candidate.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /value = 2/);
  await put(project.project, 'tsconfig.json', '{"compilerOptions":{"target":"ESNext"}}');
  const config = await runBuild(optionsFor(project));

  assert.equal(status(config, 'bundler/gameplay:scripts/main.js'), 'executed');
});
