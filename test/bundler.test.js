import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { bundleScripts } from '../packages/bundler/src/index.ts';
import { runBuild } from '../src/run.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-bundler-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packs/BP/scripts'), { recursive: true });
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify({ modules: [{ type: 'data' }] }));
  await writeFile(path.join(root, 'packs/BP/scripts/custom.js'), 'export const custom = true;');
  const config = {
    type: 'minecraftBedrock',
    name: 'Bundle',
    authors: [],
    targetVersion: '1.26.50',
    namespace: 'bundle_test',
    worlds: [],
    packs: { behaviorPack: './packs/BP' },
    bedrockCore: {
      formatVersion: '1.0.0',
      profiles: {
        default: {
          stages: { bundler: { entry: './main.ts', debug: true } },
          export: { path: './dist' },
        },
      },
    },
  };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, config, configPath };
}

test('standalone API bundles TS, JS and JSON without the runner', async (t) => {
  const { root } = await fixture(t);

  await writeFile(path.join(root, 'value.json'), '{"value":7}');
  await writeFile(path.join(root, 'helper.js'), 'export const double = x => x * 2;');
  await writeFile(
    path.join(root, 'main.ts'),
    `import data from './value.json'; import { double } from './helper.js'; export const result: number = double(data.value);`,
  );
  const result = await bundleScripts({
    root,
    entry: 'main.ts',
    outfile: './out/main.mjs',
    debug: true,
  });

  assert.equal((await import(pathToFileURL(path.join(root, 'out/main.mjs')).href)).result, 14);
  assert.equal(result.files.length, 2);
  assert.equal(
    result.inputs.some(file => file.endsWith('value.json')),
    true,
  );
});
test('runner bundles a generated artifact and project npm dependency without other stages', async (t) => {
  const { root, config, configPath } = await fixture(t);

  await mkdir(path.join(root, 'node_modules/test-dependency'), { recursive: true });
  await writeFile(
    path.join(root, 'node_modules/test-dependency/package.json'),
    '{"name":"test-dependency","type":"module","exports":"./index.js"}',
  );
  await writeFile(
    path.join(root, 'node_modules/test-dependency/index.js'),
    'export const multiplier = 3;',
  );
  await writeFile(
    path.join(root, 'main.ts'),
    `import data from '@bedrock-core/generated/items'; import { multiplier } from 'test-dependency'; export const result = data.value * multiplier;`,
  );
  await writeFile(
    path.join(root, 'generate.ts'),
    `import { writeFile } from 'node:fs/promises'; import path from 'node:path'; export async function run(ctx) { const file = path.join(ctx.generatedDir, 'items.json'); await writeFile(file, '{"value":9}'); await ctx.registerArtifact('items', file); }`,
  );
  config.bedrockCore.plugins = { items: { module: './generate.ts' } };
  const profile = config.bedrockCore.profiles.default;

  profile.steps = [{ plugin: 'items', before: 'bundler' }];
  profile.stages.bundler.generatedImports = { '@bedrock-core/generated/items': 'items' };
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });
  const bundle = await readFile(
    path.join(result.outputPath, 'behaviorPack/scripts/main.js'),
    'utf8',
  );
  const executable = path.join(root, 'verify.mjs');

  await writeFile(executable, bundle);
  assert.equal((await import(pathToFileURL(executable).href)).result, 27);
  assert.equal(
    result.artifacts.some(artifact => artifact.id === 'bundler:script'),
    true,
  );
  assert.deepEqual(await readdir(path.join(root, 'packs/BP/scripts')), ['custom.js']);
  assert.equal(
    await readFile(path.join(result.outputPath, 'behaviorPack/scripts/custom.js'), 'utf8'),
    'export const custom = true;',
  );
});
test('Minecraft imports remain external and staged tsconfig aliases resolve', async (t) => {
  const { root, configPath } = await fixture(t);

  await writeFile(path.join(root, 'helper.ts'), 'export const value = 12;');
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@local/*': ['./*'] } } }),
  );
  await writeFile(
    path.join(root, 'main.ts'),
    `import { value } from '@local/helper'; import { world } from '@minecraft/server'; world.sendMessage(String(value));`,
  );
  await runBuild({ configPath, logger: {} });
  const output = await readFile(path.join(root, 'dist/behaviorPack/scripts/main.js'), 'utf8');

  assert.match(output, /@minecraft\/server/);
  assert.doesNotMatch(output, /@local\/helper/);
});
test('pack-local TypeScript entry compiles without exporting its consumed source', async (t) => {
  const { root, config, configPath } = await fixture(t);
  const input = path.join(root, 'packs/BP/scripts/main.ts');

  await writeFile(input, 'export const value: number = 42;');
  config.bedrockCore.profiles.default.stages.bundler.entry = './packs/BP/scripts/main.ts';
  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  assert.match(await readFile(input, 'utf8'), /number/);
  assert.match(await readFile(path.join(root, 'dist/behaviorPack/scripts/main.js'), 'utf8'), /42/);
  await assert.rejects(readFile(path.join(root, 'dist/behaviorPack/scripts/main.ts')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(root, 'dist/behaviorPack/manifest.json'), 'utf8')).modules[0].type, 'data');
});

test('invalid imports and claimed output paths keep prior exports intact', async (t) => {
  const { root, configPath } = await fixture(t);

  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist/previous'), 'previous');
  await writeFile(
    path.join(root, 'main.ts'),
    `import missing from '@bedrock-core/generated/missing'; console.log(missing);`,
  );
  await assert.rejects(runBuild({ configPath, logger: {} }), /Missing generated import/);
  assert.equal(await readFile(path.join(root, 'dist/previous'), 'utf8'), 'previous');
  await writeFile(path.join(root, 'main.ts'), 'export const result = 1;');
  await writeFile(path.join(root, 'packs/BP/scripts/main.js'), 'plugin-owned');
  await assert.rejects(runBuild({ configPath, logger: {} }), /output already exists/);
  assert.equal(await readFile(path.join(root, 'dist/previous'), 'utf8'), 'previous');
});
