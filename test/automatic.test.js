import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBuild } from '../src/run.ts';
import { validateConfig } from '../src/config.ts';
import { projectFor } from '../test-support/project.js';
import { translationsFor, put } from '../test-support/i18n.js';
import { seedSchemas } from '../test-support/schemas.js';

const status = (result, stage) => result.stages.find(entry => entry.stage === stage)?.status;

async function automatic(project) {
  delete project.config.bedrockCore.profiles.default.stages;
  await writeFile(project.configPath, JSON.stringify(project.config));
}

async function exportedValue(project) {
  const source = await readFile(path.join(project.project, 'dist/gameplay/scripts/main.js'), 'utf8');

  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).value;
}

test('omitted stages detect script-only inputs without fetching generator schemas', async (t) => {
  const project = await projectFor(t);

  await automatic(project);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected schema download');
  });
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(status(result, 'manifest'), 'executed');
  assert.equal(status(result, 'bundler'), 'executed');

  for (const stage of ['generator', 'guides', 'i18n', 'ui-compiler']) {
    assert.equal(status(result, stage), 'skipped');
  }

  assert.equal(await exportedValue(project), 1);
});

test('nested manifest script entries and their helpers are excluded from template detection', async (t) => {
  const project = await projectFor(t);

  await automatic(project);
  project.behavior.modules[0].entry = 'scripts/runtime/main.js';
  await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
  await put(project.project, 'packs/gameplay/scripts/runtime/main.ts', `import { value } from './helper.ts'; export { value };`);
  await put(project.project, 'packs/gameplay/scripts/runtime/helper.ts', 'export const value = 12;');
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected schema download');
  });
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(status(result, 'generator'), 'skipped');
  assert.equal(status(result, 'bundler'), 'executed');
  assert.match(await readFile(path.join(result.outputPaths.gameplay, 'scripts/runtime/main.js'), 'utf8'), /12/);
});

test('templates and locale modules automatically enable their producers and generated imports', async (t) => {
  const project = await translationsFor(t);

  await automatic(project);
  await seedSchemas(project.project);
  await put(project.project, 'packs/gameplay/items/value.ts', 'export default { value: 7 };');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from '@bedrock-core/generated/i18n'; export const value = data.namespace;`);
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(status(result, 'generator'), 'executed');
  assert.equal(status(result, 'i18n'), 'executed');
  assert.equal(await exportedValue(project), 'flow_test');
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'items/value.json'), 'utf8')), { value: 7 });
  assert.equal(result.artifacts.find(artifact => artifact.id === 'i18n:bundle').importAs, '@bedrock-core/generated/i18n');
});

test('automatic detection sees inputs created by before hooks and still runs after hooks', async (t) => {
  const project = await projectFor(t);

  await automatic(project);
  await seedSchemas(project.project);
  await put(project.project, 'create.ts', `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      if (settings.create) {
        const directory = path.join(context.packs.gameplay, 'items');
        await mkdir(directory);
        await writeFile(path.join(directory, 'new.ts'), 'export default { created: true };');
      } else {
        await writeFile(path.join(context.packs.visuals, 'hook.txt'), 'after skipped stage');
      }
    }
  `);
  project.config.bedrockCore.plugins = { create: { module: './create.ts' } };
  project.config.bedrockCore.profiles.default.steps = [
    { plugin: 'create', before: 'generator', settings: { create: true } },
    { plugin: 'create', after: 'i18n' },
  ];
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(status(result, 'generator'), 'executed');
  assert.equal(status(result, 'i18n'), 'skipped');
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'items/new.json'), 'utf8')), { created: true });
  assert.equal(await readFile(path.join(result.outputPaths.visuals, 'hook.txt'), 'utf8'), 'after skipped stage');
});

test('false disables detected stages and auto is accepted by the configuration schema', async (t) => {
  const project = await translationsFor(t);

  await put(project.project, 'guides/start.md', '# Start');
  project.config.bedrockCore.profiles.default.stages = { guides: false, i18n: false, bundler: 'auto' };
  validateConfig(project.config);
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(status(result, 'guides'), undefined);
  assert.equal(status(result, 'i18n'), undefined);
  assert.equal(status(result, 'bundler'), 'executed');
  delete project.config.bedrockCore.profiles.default.stages.guides;
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /Stage implementation unavailable: guides/);
});

test('unchanged local bundles restore to fresh staging and preserve artifacts and dependencies', async (t) => {
  const project = await projectFor(t);
  const options = { configPath: project.configPath, logger: {} };
  const first = await runBuild(options);
  const output = await readFile(path.join(first.outputPaths.gameplay, 'scripts/main.js'), 'utf8');
  const map = await readFile(path.join(first.outputPaths.gameplay, 'scripts/main.js.map'), 'utf8');

  await rm(path.join(first.outputPaths.gameplay, 'scripts/main.js'));
  const second = await runBuild(options);

  assert.equal(status(first, 'bundler'), 'executed');
  assert.equal(status(second, 'bundler'), 'cached');
  assert.deepEqual(second.dependencies, first.dependencies);
  assert.deepEqual(second.artifacts, first.artifacts);
  assert.equal(await readFile(path.join(second.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), output);
  assert.equal(await readFile(path.join(second.outputPaths.gameplay, 'scripts/main.js.map'), 'utf8'), map);
  assert.equal(await exportedValue(project), 1);
});

test('local import edits invalidate bundles while unrelated additions remain cached', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from './value.json'; export const value = data.value;`);
  await put(project.project, 'packs/gameplay/scripts/value.json', '{"value":11}');
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
  await put(project.project, 'packs/gameplay/scripts/value.json', '{"value":22}');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 22);
  await put(project.project, 'new-input.json', '{}');
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
});

test('corrupt cache bytes are discarded and rebuilt', async (t) => {
  const project = await projectFor(t);
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const directory = path.join(project.project, '.bedrock-core/cache/build');
  const file = path.join(directory, (await readdir(directory))[0], 'files.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  const entry = path.join(path.dirname(file), 'entries', `${Object.values(record.files)[0]}.json`);
  const compilation = JSON.parse(await readFile(entry, 'utf8'));

  compilation.files[0].content = Buffer.from('export const value = 999;').toString('base64');
  await writeFile(entry, JSON.stringify(compilation));
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 1);
  await writeFile(file, '{invalid');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
});

test('profile cache false bypasses compiled-output reuse', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.cache = false;
  await writeFile(project.configPath, JSON.stringify(project.config));
  const options = { configPath: project.configPath, logger: {} };

  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  await assert.rejects(readdir(path.join(project.project, '.bedrock-core/cache/build')), { code: 'ENOENT' });
});

test('npm imports reuse compiled code until a package input changes', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'node_modules/test-dependency/package.json', '{"name":"test-dependency","type":"module","exports":"./index.js"}');
  await put(project.project, 'node_modules/test-dependency/index.js', 'export const value = 31;');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `export { value } from 'test-dependency';`);
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
  await put(project.project, 'node_modules/test-dependency/index.js', 'export const value = 32;');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 32);
  await put(project.project, 'node_modules/test-dependency/unrelated.js', 'export const unrelated = 99;');
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
  await put(project.project, 'node_modules/test-dependency/next.js', 'export const value = 33;');
  await put(project.project, 'node_modules/test-dependency/package.json', '{"name":"test-dependency","type":"module","exports":"./next.js"}');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 33);
});

test('installing a nearer project dependency invalidates its importing bundle', async (t) => {
  const project = await projectFor(t);

  await put(project.root, 'node_modules/test-dependency/package.json', '{"name":"test-dependency","type":"module","exports":"./index.js"}');
  await put(project.root, 'node_modules/test-dependency/index.js', 'export const value = 40;');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `export { value } from 'test-dependency';`);
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
  await put(project.project, 'node_modules/test-dependency/package.json', '{"name":"test-dependency","type":"module","exports":"./index.js"}');
  await put(project.project, 'node_modules/test-dependency/index.js', 'export const value = 41;');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 41);
});

test('template and plugin execution repeat while changing generated inputs invalidate compilation', async (t) => {
  const project = await projectFor(t);

  await automatic(project);
  await seedSchemas(project.project);
  await put(project.project, 'packs/gameplay/items/random.ts', 'export default { value: Math.random() };');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from '@bedrock-core/generated/value'; export const value = data.value;`);
  await put(project.project, 'producer.ts', `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const file = path.join(context.generatedDir, 'value.json');
      await writeFile(file, JSON.stringify({ value: Math.random() }));
      await context.registerArtifact('value', file, { importAs: '@bedrock-core/generated/value' });
    }
  `);
  project.config.bedrockCore.plugins = { producer: { module: './producer.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'producer', before: 'bundler' }];
  await writeFile(project.configPath, JSON.stringify(project.config));
  const options = { configPath: project.configPath, logger: {} };

  t.mock.method(Math, 'random', () => 0.25);
  await runBuild(options);
  const first = JSON.parse(await readFile(path.join(project.project, 'dist/gameplay/items/random.json'), 'utf8'));

  t.mock.method(Math, 'random', () => 0.75);
  const second = await runBuild(options);

  assert.deepEqual(first, { value: 0.25 });
  assert.deepEqual(JSON.parse(await readFile(path.join(second.outputPaths.gameplay, 'items/random.json'), 'utf8')), { value: 0.75 });
  assert.equal(await exportedValue(project), 0.75);
  assert.equal(status(second, 'bundler'), 'executed');
});

test('cache hits still validate final artifacts and preserve the previous export on failure', async (t) => {
  const project = await projectFor(t);
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const previous = await readFile(path.join(project.project, 'dist/gameplay/scripts/main.js'), 'utf8');
  let validated = false;

  await assert.rejects(runBuild({
    ...options,
    async validateArtifacts(context) {
      validated = true;
      assert.equal(context.artifact('bundler:gameplay:scripts/main.js:script').owner, 'bundler');
      throw new Error('Rejected final artifacts');
    },
  }), /Rejected final artifacts/);
  assert.equal(validated, true);
  assert.equal(await readFile(path.join(project.project, 'dist/gameplay/scripts/main.js'), 'utf8'), previous);
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
});

test('JSONC configs and inherited aliases reuse compilation and track fallback candidates', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'tsconfig.json', '{// Project compiler settings\n "extends":"./base.json",}');
  await put(project.project, 'base.json', '{"compilerOptions":{"paths":{"data":["./shared/preferred.ts","./shared/fallback.ts"]}}}');
  await put(project.project, 'shared/fallback.ts', 'export const value = 10;');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `export { value } from 'data';`);
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
  await put(project.project, 'shared/unrelated.ts', 'export const value = 0;');
  assert.equal(status(await runBuild(options), 'bundler'), 'cached');
  await put(project.project, 'shared/preferred.ts', 'export const value = 20;');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 20);
  await put(project.project, 'base.json', '{"compilerOptions":{"paths":{"data":["./shared/fallback.ts"]}}}');
  assert.equal(status(await runBuild(options), 'bundler'), 'executed');
  assert.equal(await exportedValue(project), 10);
});
