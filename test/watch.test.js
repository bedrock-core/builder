import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watchBuild } from '../src/watch.ts';
import { projectFor } from '../test-support/project.js';
import { seedSchemas } from '../test-support/schemas.js';
import { translationsFor, put } from '../test-support/i18n.js';
import { guidesFor } from '../test-support/guides.js';

async function waitFor(condition) {
  const deadline = Date.now() + 10000;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a watch build');
    }

    await delay(20);
  }
}

test('watch recompiles changed guide pages and reuses other pages on script edits', { timeout: 15000 }, async (t) => {
  const project = await guidesFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await put(project.project, 'guides/en_US/next.md', '# Next\n\nUpdated in watch.');
  await waitFor(() => results.length >= 2);
  const guide = results.at(-1);

  assert.equal(guide.compilations.find(item => item.id === 'guides/page:guides/en_US/next.md').status, 'executed');
  assert.equal(guide.compilations.find(item => item.id === 'guides/page:guides/en_US/start.mdx').status, 'cached');
  assert.match(await readFile(path.join(guide.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /Updated in watch/);
  const count = results.length;

  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export const value = 3;');
  await waitFor(() => results.length > count);
  assert.equal(results.at(-1).stages.find(item => item.stage === 'guides').status, 'cached');
  await delay(150);
  assert.deepEqual(errors, []);
});

test('watch reuses templates on script edits and rebuilds template consumers on imported data edits', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'shared/value.json', '{"value":1}');
  await put(project.project, 'packs/gameplay/data/value.ts', `import data from '../../../shared/value.json'; export default data;`);
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from '../data/value.json'; export const value = data.value;`);
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import data from '../data/value.json'; export const value = data.value + 1;`);
  await waitFor(() => results.length >= 2);
  const script = results.at(-1);

  assert.equal(script.compilations.find(task => task.id === 'generator/packs/gameplay/data/value.ts').status, 'cached');
  assert.equal(script.compilations.find(task => task.id === 'bundler/gameplay:scripts/main.js').status, 'executed');
  const count = results.length;

  await put(project.project, 'shared/value.json', '{"value":2}');
  await waitFor(() => results.length > count);
  const generated = results.at(-1);

  assert.equal(generated.compilations.find(task => task.id === 'generator/packs/gameplay/data/value.ts').status, 'executed');
  assert.equal(generated.compilations.find(task => task.id === 'bundler/gameplay:scripts/main.js').status, 'executed');
  assert.deepEqual(JSON.parse(await readFile(path.join(generated.outputPaths.gameplay, 'data/value.json'), 'utf8')), { value: 2 });
  await delay(200);
  assert.deepEqual(errors, []);
});

test('watch recovers from invalid export paths and ignores current and former destinations', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const variable = 'BEDROCK_CORE_WATCH_EXPORT_ROOT';
  const previousEnvironment = process.env[variable];

  process.env[variable] = path.join(project.project, 'environment output');
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = previousEnvironment;
      }

      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  const previous = results[0].outputPaths.gameplay;

  project.config.bedrockCore.profiles.default.export.gameplay = '.';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await waitFor(() => errors.length > 0);
  project.config.bedrockCore.profiles.default.export.gameplay = `%${variable}%/BP`;
  project.config.bedrockCore.profiles.default.export.visuals = '${' + variable + '}/RP';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await waitFor(() => results.length >= 2);
  await delay(200);
  const count = results.length;

  assert.equal(results.at(-1).outputPaths.gameplay, path.join(process.env[variable], 'BP'));
  assert.equal(results.at(-1).outputPaths.visuals, path.join(process.env[variable], 'RP'));
  await writeFile(path.join(previous, 'ignored.json'), '{}');
  await writeFile(path.join(results.at(-1).outputPaths.visuals, 'ignored.json'), '{}');
  await delay(200);
  assert.equal(results.length, count);
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 55;');
  await waitFor(() => results.length > count);
  assert.match(await readFile(path.join(results.at(-1).outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /value = 55/);
});

test('watch reloads translation imports, adds locales and avoids declaration output loops', { timeout: 15000 }, async (t) => {
  const project = await translationsFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  await put(project.project, 'shared/title.ts', 'export const title = "First" as const;');
  await put(project.project, 'i18n/en_US.ts', 'import { title } from "../shared/title.ts"; export default { shop: { title } } as const;');
  await put(project.project, 'i18n/cs_CZ.ts', 'export default { shop: { title: "Obchod" } } as const;');
  delete project.config.packs.gameplay;
  delete project.config.bedrockCore.profiles.default.export.gameplay;
  project.config.bedrockCore.profiles.default.stages = { i18n: true };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await delay(200);
  assert.equal(results.length, 1);
  await put(project.project, 'shared/title.ts', 'export const title = "Second" as const;');
  await waitFor(() => results.length >= 2);
  assert.match(await readFile(path.join(results.at(-1).outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /flow_test.shop.title=Second/);
  await put(project.project, 'i18n/fr_FR.ts', 'export default { shop: { title: "Boutique" } } as const;');
  await waitFor(() => results.length >= 3);
  assert.match(await readFile(path.join(results.at(-1).outputPaths.visuals, 'texts/fr_FR.lang'), 'utf8'), /Boutique/);
  const count = results.length;

  await delay(200);
  assert.equal(results.length, count);
  assert.deepEqual(errors, []);
});

test('watch exports to separate local and development paths without output loops and recovers after errors', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.export.gameplay = './minecraft/development_behavior_packs/gameplay';
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await delay(200);
  assert.equal(results.length, 1);
  const first = results[0];
  const output = path.join(first.outputPaths.gameplay, 'scripts/main.js');
  const source = path.join(project.project, 'packs/gameplay/scripts/main.ts');
  const previous = await readFile(output, 'utf8');

  await writeFile(source, 'invalid TypeScript syntax ?');
  await waitFor(() => errors.length > 0);
  assert.equal(await readFile(output, 'utf8'), previous);
  await writeFile(source, 'export const value = 8;');
  await waitFor(() => results.length > 1);
  assert.match(await readFile(output, 'utf8'), /value = 8/);
  const count = results.length;

  await delay(200);
  assert.equal(results.length, count);
});

test('watch tracks external plugin dependencies and serializes changes arriving during a build', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const dependency = path.join(project.root, 'external.json');
  const results = [];
  const errors = [];
  let concurrent = 0;
  let maximumConcurrent = 0;

  await writeFile(dependency, '{"value":1}');
  await writeFile(path.join(project.project, 'dependency.ts'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      context.registerDependency(settings.path);
      await writeFile(path.join(context.packs.visuals, 'dependency.json'), await readFile(settings.path));
    }
  `);
  project.config.bedrockCore.plugins = { dependency: { module: './dependency.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'dependency', after: 'manifest', settings: { path: dependency } }];
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 20 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    validateArtifacts: async () => {
      concurrent++;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await delay(80);
      concurrent--;
    },
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await writeFile(dependency, '{"value":2}');
  await waitFor(() => concurrent === 1);
  await mkdir(path.join(project.project, 'new-input'));
  await writeFile(path.join(project.project, 'new-input/file.json'), '{}');
  await waitFor(() => results.length >= 3);
  assert.equal(maximumConcurrent, 1);
  assert.deepEqual(errors, []);
  assert.equal(await readFile(path.join(results.at(-1).outputPaths.visuals, 'dependency.json'), 'utf8'), '{"value":2}');
});

test('watch reloads local plugin helpers and recovers from invalid config edits', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const helper = path.join(project.project, 'helper.ts');

  await writeFile(helper, 'export const value = 1;');
  await writeFile(path.join(project.project, 'plugin.ts'), `
    import { value } from './helper.ts';
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      await writeFile(path.join(context.packs.visuals, 'helper.json'), JSON.stringify({ value }));
    }
  `);
  project.config.bedrockCore.plugins = { helper: { module: './plugin.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'helper', after: 'manifest' }];
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await writeFile(project.configPath, '{ invalid config');
  await waitFor(() => errors.length > 0);
  await writeFile(helper, 'export const value = 7;');
  await writeFile(project.configPath, JSON.stringify(project.config));
  await waitFor(() => results.length >= 2);
  assert.equal(await readFile(path.join(results.at(-1).outputPaths.visuals, 'helper.json'), 'utf8'), '{"value":7}');
});

test('watch reloads generator npm imports and recovers after a template failure', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const dependency = path.join(project.project, 'node_modules/template-data/index.js');
  const template = path.join(project.project, 'packs/visuals/generated.ts');

  await mkdir(path.dirname(dependency), { recursive: true });
  await writeFile(path.join(path.dirname(dependency), 'package.json'), '{"name":"template-data","type":"module","exports":"./index.js"}');
  await writeFile(dependency, 'export const value = 1;');
  await writeFile(template, 'import { value } from "template-data"; export default { value };');
  delete project.config.packs.gameplay;
  delete project.config.bedrockCore.profiles.default.export.gameplay;
  project.config.bedrockCore.profiles.default.stages = { generator: { types: false } };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  const output = path.join(results[0].outputPaths.visuals, 'generated.json');

  assert.equal(await readFile(output, 'utf8'), '{"value":1}');
  await writeFile(dependency, 'export const value = 7;');
  await waitFor(() => results.length >= 2);
  assert.equal(await readFile(output, 'utf8'), '{"value":7}');
  await writeFile(template, 'throw new Error("invalid generator"); export default {};');
  await waitFor(() => errors.length > 0);
  assert.equal(await readFile(output, 'utf8'), '{"value":7}');
  await writeFile(template, 'import { value } from "template-data"; export default { value: value * 2 };');
  await waitFor(() => results.length >= 3);
  assert.equal(await readFile(output, 'utf8'), '{"value":14}');
});

test('watch ignores generated editor declarations and still rebuilds authored templates', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const { version } = await seedSchemas(project.project);
  const cancellation = new AbortController();
  const results = [];
  const errors = [];
  const template = path.join(project.project, 'packs/visuals/generated.ts');
  const declarations = path.join(project.project, 'editor/mc/globals.d.ts');

  delete project.config.packs.gameplay;
  delete project.config.bedrockCore.profiles.default.export.gameplay;
  project.config.bedrockCore.profiles.default.stages = { generator: { schemaVersion: version, typesDir: 'editor/mc' } };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(template, 'export default { value: 1 };');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  const original = await readFile(declarations, 'utf8');

  assert.match(original, /declare type Entity/);
  await writeFile(declarations, `${original}\n// Editor declaration edit.\n`);
  await delay(200);
  assert.equal(results.length, 1);
  await writeFile(template, 'export default { value: 2 };');
  await waitFor(() => results.length >= 2);
  assert.equal(await readFile(path.join(results.at(-1).outputPaths.visuals, 'generated.json'), 'utf8'), '{"value":2}');
  await delay(200);
  assert.equal(results.length, 2);
  assert.deepEqual(errors, []);
});
