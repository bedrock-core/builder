import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '@bedrock-core/builder/runner';
import { projectFor } from '../test-support/project.js';

async function put(project, name, source) {
  const file = path.join(project.project, name);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
}

async function pluginProject(t) {
  const project = await projectFor(t);

  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(project.project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  project.config.bedrockCore.profiles.default.stages.generator = false;

  return project;
}

async function save(project) {
  await writeFile(project.configPath, JSON.stringify(project.config));
}

async function runtime(result) {
  const code = await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

test('a built-in generator package runs as an external plugin with the same artifacts and cache services', async (t) => {
  const project = await pluginProject(t);

  await put(project, 'packs/gameplay/content/widget.ts', 'export default { weight: 7 };');
  project.config.bedrockCore.plugins = { content: { module: '@bedrock-core/builder-generator/plugin' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'content', before: 'bundler', mode: 'auto', settings: { types: false } }];
  await save(project);
  const options = { configPath: project.configPath, logger: {} };
  const first = await runBuild(options);
  const second = await runBuild(options);

  assert.deepEqual(JSON.parse(await readFile(path.join(first.outputPaths.gameplay, 'content/widget.json'), 'utf8')), { weight: 7 });
  assert.ok(first.artifacts.some(artifact => artifact.id === 'generator:gameplay:content/widget.json' && artifact.owner.startsWith('content:')));
  assert.ok(!first.stages.some(stage => stage.stage === 'generator'));
  const reused = second.compilations.filter(entry => entry.id.startsWith('content:'));

  assert.ok(reused.length > 0);
  assert.ok(reused.every(entry => entry.status === 'cached'));
});

test('one external feature owns generated registry data and custom bundling with dependency-aware reuse', async (t) => {
  const project = await pluginProject(t);

  await put(project, 'feature/builder.ts', `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { fingerprint } from '@bedrock-core/builder-plugin';
    export async function run(context) {
      const implementation = await fingerprint([new URL(import.meta.url)]);
      const definitions = path.join(context.packs.gameplay, 'content/widgets.json');
      const tuning = path.join(context.stagedRoot, 'feature/tuning.txt');
      const output = path.join(context.generatedDir, 'widgets.mjs');
      await context.reuse('registry-data', {
        inputs: [definitions], key: implementation,
        async run() {
          const records = JSON.parse(await readFile(definitions, 'utf8'));
          await writeFile(output, 'export default ' + JSON.stringify(records) + ';');
          return { value: null, files: [output] };
        },
      });
      await context.registerArtifact('widgets:data', output, { importAs: '@bedrock-core/generated/widgets' });
      context.registerBundleExtension({
        id: 'example:widgets', version: implementation, cache: true,
        plugins: [{
          name: 'widget-content',
          setup(build) {
            build.onLoad({ filter: /\\.item$/, namespace: 'file' }, async args => {
              const data = JSON.parse(await readFile(args.path, 'utf8'));
              data.weight += Number(await readFile(tuning, 'utf8'));
              return { contents: 'export default ' + JSON.stringify(data), loader: 'js', watchFiles: [args.path, tuning] };
            });
          },
        }],
      });
      return { reason: 'widget content prepared' };
    }
  `);
  await put(project, 'feature/tuning.txt', '1');
  await put(project, 'packs/gameplay/content/widgets.json', '[{"id":"first","weight":3}]');
  await put(project, 'packs/gameplay/content/sample.item', '{"weight":8}');
  await put(project, 'packs/gameplay/scripts/registry.ts', `
    import definitions from '@bedrock-core/generated/widgets';
    export function registerWidgets() {
      return { install(core) {
        const registry = new Map(definitions.map(value => [value.id, value]));
        core.fill('example:widgets', registry);
        return registry;
      } };
    }
  `);
  await put(project, 'packs/gameplay/scripts/main.ts', `
    import sample from '../content/sample.item';
    export { registerWidgets } from './registry.ts';
    export const value = sample.weight;
  `);
  project.config.bedrockCore.plugins = { widgets: { module: './feature/builder.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'widgets', before: 'bundler' }];
  await save(project);
  const options = { configPath: project.configPath, logger: {} };
  const first = await runBuild(options);
  const exported = await runtime(first);
  const slots = new Map();
  const registry = exported.registerWidgets().install({ fill: (id, value) => slots.set(id, value) });

  assert.equal(exported.value, 9);
  assert.deepEqual(registry.get('first'), { id: 'first', weight: 3 });
  assert.equal(slots.get('example:widgets'), registry);
  assert.ok(first.dependencies.includes(path.join(project.project, 'feature/tuning.txt')));
  const second = await runBuild(options);

  assert.equal(second.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  assert.ok(second.compilations.some(entry => entry.id.endsWith('/registry-data') && entry.status === 'cached'));
  await put(project, 'feature/tuning.txt', '4');
  const third = await runBuild(options);

  assert.equal(third.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.equal((await runtime(third)).value, 12);
  await put(project, 'packs/gameplay/content/widgets.json', '[{"id":"second","weight":5}]');
  const fourth = await runBuild(options);
  const updated = (await runtime(fourth)).registerWidgets().install({ fill() {} });

  assert.equal(updated.has('first'), false);
  assert.deepEqual(updated.get('second'), { id: 'second', weight: 5 });
  assert.match(await readFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'utf8'), /sample\.item/);
});

test('external auto mode uses plugin detection while explicit execution bypasses it', async (t) => {
  const project = await pluginProject(t);

  await put(project, 'feature.ts', `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export function detect(context, settings) { return { needed: settings.enabled, reason: 'feature selection' }; }
    export async function run(context) { await writeFile(path.join(context.packs.visuals, 'feature.txt'), 'ran'); }
  `);
  project.config.bedrockCore.plugins = { feature: { module: './feature.ts' } };
  const step = { plugin: 'feature', before: 'bundler', mode: 'auto', settings: { enabled: false } };

  project.config.bedrockCore.profiles.default.steps = [step];
  await save(project);
  const skipped = await runBuild({ configPath: project.configPath, logger: {} });

  await assert.rejects(readFile(path.join(skipped.outputPaths.visuals, 'feature.txt')), { code: 'ENOENT' });
  step.mode = 'always';
  await save(project);
  const forced = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(await readFile(path.join(forced.outputPaths.visuals, 'feature.txt'), 'utf8'), 'ran');
});

test('invalid plugin detection aborts publication and retains the prior export', async (t) => {
  const project = await pluginProject(t);
  const options = { configPath: project.configPath, logger: {} };

  await save(project);
  const first = await runBuild(options);
  const output = path.join(first.outputPaths.gameplay, 'scripts/main.js');
  const before = await readFile(output, 'utf8');

  await put(project, 'invalid.ts', 'export function detect() { return null; } export function run() {}');
  project.config.bedrockCore.plugins = { invalid: { module: './invalid.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'invalid', before: 'bundler', mode: 'auto' }];
  await save(project);
  await assert.rejects(runBuild(options), /Plugin detect must return/);
  assert.equal(await readFile(output, 'utf8'), before);
});

test('bundling extensions rebuild by default when custom loader inputs are not declared cacheable', async (t) => {
  const project = await pluginProject(t);

  await put(project, 'uncached.ts', `
    export function run(context) {
      context.registerBundleExtension({ id: 'example:uncached', version: '1', plugins: [{ name: 'uncached', setup() {} }] });
    }
  `);
  project.config.bedrockCore.plugins = { uncached: { module: './uncached.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'uncached', before: 'bundler' }];
  await save(project);
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const second = await runBuild(options);

  assert.equal(second.stages.find(stage => stage.stage === 'bundler').status, 'executed');
});

test('full plugin replacements use their own detector through the shared stage runner', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.stages.bundler = 'auto';
  await save(project);
  let detected = 0;
  let executed = 0;
  const result = await runBuild({
    configPath: project.configPath, logger: {},
    stages: { bundler: {
      detect() {
        detected++;

        return { needed: true, reason: 'custom bundle input' };
      },
      async run(context) {
        executed++;

        await writeFile(path.join(context.packs.gameplay, 'scripts/main.js'), 'export const value = 27;');

        return { reason: 'custom bundler' };
      },
    } },
  });

  assert.equal(detected, 1);
  assert.equal(executed, 1);
  assert.equal((await runtime(result)).value, 27);
  assert.equal(result.stages.find(stage => stage.stage === 'bundler').reason, 'custom bundler');
});

test('external plugins can provide virtual runtime modules through bundler resolution hooks', async (t) => {
  const project = await pluginProject(t);

  await put(project, 'virtual.ts', `
    export function run(context) {
      context.registerBundleExtension({
        id: 'example:virtual', version: '1', cache: true,
        plugins: [{ name: 'virtual-data', setup(build) {
          build.onResolve({ filter: /^widget-data$/ }, () => ({ path: 'widgets', namespace: 'widget-data' }));
          build.onLoad({ filter: /.*/, namespace: 'widget-data' }, () => ({ contents: 'export default 41;', loader: 'js' }));
        } }],
      });
    }
  `);
  await put(project, 'packs/gameplay/scripts/main.ts', `import value from 'widget-data'; export { value };`);
  project.config.bedrockCore.plugins = { virtual: { module: './virtual.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'virtual', before: 'bundler' }];
  await save(project);
  const options = { configPath: project.configPath, logger: {} };
  const first = await runBuild(options);

  assert.equal((await runtime(first)).value, 41);
  const second = await runBuild(options);

  assert.equal(second.stages.find(stage => stage.stage === 'bundler').status, 'executed');
});

test('targeted plugins scope bundler extensions to their current pack by default', async (t) => {
  const project = await pluginProject(t);

  project.config.packs = { visuals: project.config.packs.visuals, gameplay: project.config.packs.gameplay };
  await put(project, 'targeted.ts', `
    export function run(context) {
      const value = context.pack.kind === 'behavior' ? 22 : 73;
      context.registerBundleExtension({
        id: 'example:' + context.pack.id, version: '1',
        plugins: [{ name: 'targeted-content', setup(build) {
          build.onLoad({ filter: /main\\.ts$/, namespace: 'file' }, args => ({
            contents: 'export const value = ' + value + ';', loader: 'ts', watchFiles: [args.path],
          }));
        } }],
      });
    }
  `);
  project.config.bedrockCore.plugins = { targeted: { module: './targeted.ts', targets: 'both' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'targeted', before: 'bundler' }];
  await save(project);
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal((await runtime(result)).value, 22);
});

test('directory-watching compiler hooks expose their dependencies and rebuild on directory changes', async (t) => {
  const project = await pluginProject(t);
  const directory = path.join(project.root, 'content');

  await mkdir(directory);
  await writeFile(path.join(directory, 'first.txt'), 'first');
  await put(project, 'directory.ts', `
    import { readdir } from 'node:fs/promises';
    export function run(context, settings) {
      context.registerBundleExtension({
        id: 'example:directory', version: '1', cache: true,
        plugins: [{ name: 'directory-data', setup(build) {
          build.onLoad({ filter: /main\\.ts$/, namespace: 'file' }, async () => ({
            contents: 'export const value = ' + (await readdir(settings.directory)).length + ';',
            loader: 'ts', watchDirs: [settings.directory],
          }));
        } }],
      });
    }
  `);
  project.config.bedrockCore.plugins = { directory: { module: './directory.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'directory', before: 'bundler', settings: { directory } }];
  await save(project);
  const options = { configPath: project.configPath, logger: {} };
  const first = await runBuild(options);

  assert.equal((await runtime(first)).value, 1);
  assert.ok(first.dependencies.includes(directory));
  await writeFile(path.join(directory, 'second.txt'), 'second');
  const second = await runBuild(options);

  assert.equal((await runtime(second)).value, 2);
  assert.equal(second.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.ok(second.dependencies.includes(directory));
});

test('an external guides plugin detects its configured source directory and selection rules', async (t) => {
  const project = await pluginProject(t);

  await put(project, 'packs/gameplay/manual/en_US/start.md', '# Start');
  project.config.bedrockCore.profiles.default.stages.guides = false;
  project.config.bedrockCore.plugins = { manual: { module: '@bedrock-core/builder-guides/plugin' } };
  const step = { plugin: 'manual', before: 'i18n', mode: 'auto', settings: { sourceDir: 'manual', include: ['**/start.md'], compileScreens: false } };

  project.config.bedrockCore.profiles.default.steps = [step];
  await save(project);
  const first = await runBuild({ configPath: project.configPath, logger: {} });

  assert.ok(first.artifacts.some(artifact => artifact.id === 'guides:gameplay:manifest' && artifact.owner.startsWith('manual:')));
  step.settings.include = ['**/other.md'];
  await save(project);
  const skipped = await runBuild({ configPath: project.configPath, logger: {} });

  assert.ok(!skipped.artifacts.some(artifact => artifact.id === 'guides:gameplay:manifest'));
});
