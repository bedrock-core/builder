import { manifestFor } from '../test-support/manifest.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBuild } from '../src/run.ts';

async function fixture(t, plugin, steps = [{ plugin: 'custom', after: 'prepare' }]) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-test-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packs/BP'), { recursive: true });
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifestFor('data')));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'packs/BP/source.json'), '{"source":true}');
  await writeFile(path.join(root, 'dist/previous.txt'), 'previous successful export');
  await writeFile(path.join(root, 'plugin.ts'), plugin);
  const config = {
    type: 'minecraftBedrock',
    name: 'Test',
    authors: [],
    namespace: 'test',
    targetVersion: '1.26.50',
    worlds: [],
    packs: { behaviorPack: './packs/BP' },
    bedrockCore: {
      formatVersion: '1.0.0',
      plugins: { custom: { module: './plugin.ts' } },
      profiles: { default: { steps, export: { path: './dist' } } },
    },
  };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, config, configPath, options: { configPath, logger: {} } };
}

const preservation = async (root) => {
  assert.equal(await readFile(path.join(root, 'packs/BP/source.json'), 'utf8'), '{"source":true}');
  assert.equal(
    await readFile(path.join(root, 'dist/previous.txt'), 'utf8'),
    'previous successful export',
  );
  assert.equal(
    (await readdir(root)).some(name => name.includes('.builder-')),
    false,
  );
};

test('TS producer and consumer share generated JSON without touching source', async (t) => {
  const project = await fixture(
    t,
    `
    import { writeFile, readFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(ctx, settings: { consume?: boolean }) {
      if (!settings.consume) {
        const file = path.join(ctx.generatedDir, 'items.json');
        await writeFile(file, JSON.stringify({ item: 'custom' }));
        await ctx.registerArtifact('items', file);
        ctx.registerDependency('plugin.ts');
      } else {
        const data = JSON.parse(await readFile(ctx.artifact('items').path, 'utf8'));
        await writeFile(path.join(ctx.packs.behaviorPack, 'generated.json'), JSON.stringify(data));
      }
    }
  `,
    [
      { plugin: 'custom', after: 'prepare' },
      { plugin: 'custom', before: 'export', settings: { consume: true } },
    ],
  );
  const result = await runBuild(project.options);

  assert.deepEqual(
    JSON.parse(await readFile(path.join(result.outputPath, 'behaviorPack/generated.json'), 'utf8')),
    { item: 'custom' },
  );
  assert.deepEqual((await readdir(path.join(project.root, 'packs/BP'))).sort(), ['manifest.json', 'source.json']);
  assert.equal(result.artifacts[0].id, 'items');
  assert.equal(result.dependencies.includes(path.join(project.root, 'plugin.ts')), true);
  await assert.rejects(readFile(path.join(result.outputPath, 'previous.txt')), { code: 'ENOENT' });
});
test('plugin failure keeps sources and previous export intact and permits retry', async (t) => {
  const project = await fixture(
    t,
    `export async function run() { throw new Error('plugin failed'); }`,
  );

  await assert.rejects(runBuild(project.options), /plugin failed/);
  await preservation(project.root);
  await writeFile(path.join(project.root, 'plugin.ts'), 'export async function run() {}');
  await runBuild(project.options);
});
test('artifact conflicts and missing artifacts fail before publication', async (t) => {
  const project = await fixture(
    t,
    `
    import path from 'node:path';
    export async function run(ctx) {
      await ctx.registerArtifact('same', path.join(ctx.packs.behaviorPack, 'source.json'));
      await ctx.registerArtifact('same', path.join(ctx.packs.behaviorPack, 'source.json'));
    }
  `,
  );

  await assert.rejects(runBuild(project.options), /already registered/);
  await preservation(project.root);
  await writeFile(
    path.join(project.root, 'plugin.ts'),
    `export async function run(ctx) { ctx.artifact('missing'); }`,
  );
  await assert.rejects(runBuild(project.options), /Missing artifact: missing/);
  await preservation(project.root);
});
test('validation failure and cooperative cancellation prevent export', async (t) => {
  const project = await fixture(t, 'export async function run() {}');

  await assert.rejects(
    runBuild({
      ...project.options,
      validateArtifacts() {
        throw new Error('invalid pack');
      },
    }),
    /invalid pack/,
  );
  await preservation(project.root);
  const cancellation = new AbortController();

  project.config.bedrockCore.profiles.default.stages = { bundler: true };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(
    runBuild({
      ...project.options,
      signal: cancellation.signal,
      stages: {
        bundler() {
          cancellation.abort(new Error('cancelled'));
        },
      },
    }),
    /cancelled/,
  );
  await preservation(project.root);
});
test('unimplemented stages and unsafe output fail before plugins run', async (t) => {
  const project = await fixture(t, 'throw new Error("plugin loaded");');

  project.config.bedrockCore.profiles.default.stages = { guides: true };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild(project.options), /Stage implementation unavailable/);
  project.config.bedrockCore.profiles.default.export.path = './packs/BP';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild(project.options), /separate project directories/);
  await preservation(project.root);
});
test('a destination lock blocks overlapping writes', async (t) => {
  const project = await fixture(t, 'export async function run() {}');
  const lock = path.join(project.root, 'dist.builder-lock');

  await mkdir(lock);
  await assert.rejects(runBuild(project.options), { code: 'EEXIST' });
  assert.equal((await readdir(project.root)).includes('dist.builder-lock'), true);
});
