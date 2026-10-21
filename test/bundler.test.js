import { manifestFor } from '../test-support/manifest.js';
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
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifestFor('script')));
  await writeFile(path.join(root, 'packs/BP/scripts/custom.js'), 'export const custom = true;');
  const config = {
    name: 'Bundle',
    authors: [],
    targetVersion: '1.26.50',
    namespace: 'bundle_test',
    packs: { behaviorPack: './packs/BP' },
    bedrockCore: {
      formatVersion: '1.0.0',
      profiles: {
        default: {
          stages: { bundler: { debug: true } },
          export: { behaviorPack: './dist/behaviorPack' },
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
    path.join(root, 'packs/BP/scripts/main.ts'),
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
    path.join(result.outputPaths.behaviorPack, 'scripts/main.js'),
    'utf8',
  );
  const executable = path.join(root, 'verify.mjs');

  await writeFile(executable, bundle);
  assert.equal((await import(pathToFileURL(executable).href)).result, 27);
  assert.equal(
    result.artifacts.some(artifact => artifact.id === 'bundler:behaviorPack:scripts/main.js:script'),
    true,
  );
  assert.deepEqual(await readdir(path.join(root, 'packs/BP/scripts')), ['custom.js', 'main.ts']);
  assert.equal(
    await readFile(path.join(result.outputPaths.behaviorPack, 'scripts/custom.js'), 'utf8'),
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
    path.join(root, 'packs/BP/scripts/main.ts'),
    `import { value } from '@local/helper'; import { world } from '@minecraft/server'; world.sendMessage(String(value));`,
  );
  await runBuild({ configPath, logger: {} });
  const output = await readFile(path.join(root, 'dist/behaviorPack/scripts/main.js'), 'utf8');

  assert.match(output, /@minecraft\/server/);
  assert.doesNotMatch(output, /@local\/helper/);
});
test('pack-local TypeScript compiles without exporting entry or unused source', async (t) => {
  const { root, config, configPath } = await fixture(t);
  const input = path.join(root, 'packs/BP/scripts/main.ts');
  const unused = path.join(root, 'packs/BP/scripts/tests/unused.ts');

  await writeFile(input, 'export const value: number = 42;');
  await mkdir(path.dirname(unused), { recursive: true });
  await writeFile(unused, 'export const unused: number = 1;');
  await writeFile(configPath, JSON.stringify(config));
  await runBuild({ configPath, logger: {} });
  assert.match(await readFile(input, 'utf8'), /number/);
  assert.match(await readFile(unused, 'utf8'), /unused/);
  assert.match(await readFile(path.join(root, 'dist/behaviorPack/scripts/main.js'), 'utf8'), /42/);
  await assert.rejects(readFile(path.join(root, 'dist/behaviorPack/scripts/main.ts')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'dist/behaviorPack/scripts/tests/unused.ts')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(root, 'dist/behaviorPack/manifest.json'), 'utf8')).modules[0].type, 'script');
});

test('invalid imports and claimed output paths keep prior exports intact', async (t) => {
  const { root, configPath } = await fixture(t);

  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist/previous'), 'previous');
  await writeFile(
    path.join(root, 'packs/BP/scripts/main.ts'),
    `import missing from '@bedrock-core/generated/missing'; console.log(missing);`,
  );
  await assert.rejects(runBuild({ configPath, logger: {} }), /Missing generated import/);
  assert.equal(await readFile(path.join(root, 'dist/previous'), 'utf8'), 'previous');
  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), 'export const result = 1;');
  await writeFile(path.join(root, 'packs/BP/scripts/main.js'), 'plugin-owned');
  await assert.rejects(runBuild({ configPath, logger: {} }), /output already exists/);
  assert.equal(await readFile(path.join(root, 'dist/previous'), 'utf8'), 'previous');
});

test('multiple script packs bundle shared inputs before staged source cleanup', async (t) => {
  const { root, config, configPath } = await fixture(t);

  await mkdir(path.join(root, 'packs/extra/scripts'), { recursive: true });
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifestFor('script', 'scripts/start.js')));
  await writeFile(path.join(root, 'packs/extra/manifest.json'), JSON.stringify(manifestFor('script', 'scripts/extra.js')));
  await writeFile(path.join(root, 'packs/BP/scripts/shared.ts'), 'export const shared: number = 17;');
  await writeFile(path.join(root, 'packs/BP/scripts/start.ts'), 'export { shared } from \'./shared.ts\';');
  await writeFile(path.join(root, 'packs/extra/scripts/extra.ts'), 'export { shared } from \'../../BP/scripts/shared.ts\';');
  config.packs.extra = './packs/extra';
  config.bedrockCore.profiles.default.export.extra = './dist/extra';
  config.bedrockCore.profiles.default.stages.bundler = { debug: true };
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });

  for (const [pack, filename] of [['behaviorPack', 'start.js'], ['extra', 'extra.js']]) {
    const output = await readFile(path.join(result.outputPaths[pack], 'scripts', filename), 'utf8');
    const executable = path.join(root, `${pack}.mjs`);

    await writeFile(executable, output);
    assert.equal((await import(pathToFileURL(executable).href)).shared, 17);
    assert.equal(result.artifacts.some(artifact => artifact.id === `bundler:${pack}:scripts/${filename}:script`), true);
  }

  await assert.rejects(readFile(path.join(result.outputPaths.behaviorPack, 'scripts/shared.ts')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(root, 'packs/BP/scripts/shared.ts'), 'utf8'), /number/);
});

test('registered TypeScript inputs remain available for validation and are omitted from cold and cached exports', async (t) => {
  const { root, config, configPath } = await fixture(t);

  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), `
    import { value } from '@bedrock-core/generated/custom';
    export const result = value;
  `);
  await writeFile(path.join(root, 'produce.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const file = path.join(context.packs.behaviorPack, 'scripts/generated.ts');
      await writeFile(file, 'export const value: number = 42;');
      await context.registerArtifact('custom', file, { importAs: '@bedrock-core/generated/custom' });
    }
  `);
  config.bedrockCore.plugins = { custom: { module: './produce.ts' } };
  config.bedrockCore.profiles.default.steps = [{ plugin: 'custom', before: 'bundler' }];
  await writeFile(configPath, JSON.stringify(config));
  let validated = 0;

  for (const expected of ['executed', 'cached']) {
    const result = await runBuild({
      configPath, logger: {},
      async validateArtifacts(context) {
        assert.equal(await readFile(context.artifact('custom').path, 'utf8'), 'export const value: number = 42;');
        validated++;
      },
    });

    assert.equal(result.stages.find(step => step.stage === 'bundler').status, expected);
    const output = result.outputPaths.behaviorPack;
    const source = await readFile(path.join(output, 'scripts/main.js'), 'utf8');

    assert.equal((await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).result, 42);
    await assert.rejects(readFile(path.join(output, 'scripts/generated.ts')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(output, 'scripts/main.ts')), { code: 'ENOENT' });
  }

  assert.equal(validated, 2);
  assert.match(await readFile(path.join(root, 'packs/BP/scripts/main.ts'), 'utf8'), /generated\/custom/);
});

test('missing manifest sources in a later pack preserve the previous export', async (t) => {
  const { root, config, configPath } = await fixture(t);

  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), 'export const result = 1;');
  await runBuild({ configPath, logger: {} });
  const output = path.join(root, 'dist/behaviorPack/scripts/main.js');
  const previous = await readFile(output, 'utf8');

  await mkdir(path.join(root, 'second/scripts'), { recursive: true });
  await writeFile(path.join(root, 'second/manifest.json'), JSON.stringify(manifestFor('script', 'scripts/missing.js')));
  config.packs.second = './second';
  config.bedrockCore.profiles.default.export.second = './dist/second';
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runBuild({ configPath, logger: {} }), /no TS\/JS source matching.*missing.js/);
  assert.equal(await readFile(output, 'utf8'), previous);
});

test('a producer registers its import name once and consumers need no alias configuration', async (t) => {
  const { root, config, configPath } = await fixture(t);

  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), `
    import data from '@bedrock-core/generated/custom';
    export const result = data.value;
  `);
  await writeFile(path.join(root, 'produce.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const file = path.join(context.generatedDir, 'custom.json');
      await writeFile(file, '{"value":42}');
      await context.registerArtifact('custom', file, { importAs: '@bedrock-core/generated/custom' });
    }
  `);
  config.bedrockCore.plugins = { custom: { module: './produce.ts' } };
  config.bedrockCore.profiles.default.steps = [{ plugin: 'custom', before: 'bundler' }];
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });
  const source = await readFile(path.join(result.outputPaths.behaviorPack, 'scripts/main.js'), 'utf8');

  assert.match(source, /value: 42/);
  const artifact = result.artifacts.find(artifact => artifact.id === 'custom');

  assert.equal(artifact.importAs, '@bedrock-core/generated/custom');
  assert.match(artifact.owner, /^custom:\d+$/);
});

test('duplicate producer import names fail before replacing a successful export', async (t) => {
  const { root, config, configPath } = await fixture(t);

  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), 'export const result = 1;');
  const previous = await runBuild({ configPath, logger: {} });
  const output = path.join(previous.outputPaths.behaviorPack, 'scripts/main.js');
  const source = await readFile(output, 'utf8');

  await writeFile(path.join(root, 'produce.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const file = path.join(context.generatedDir, 'custom.json');
      await writeFile(file, '{}');
      await context.registerArtifact('first', file, { importAs: '@bedrock-core/generated/custom' });
      await context.registerArtifact('second', file, { importAs: '@bedrock-core/generated/custom' });
    }
  `);
  config.bedrockCore.plugins = { custom: { module: './produce.ts' } };
  config.bedrockCore.profiles.default.steps = [{ plugin: 'custom', before: 'bundler' }];
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runBuild({ configPath, logger: {} }), /Generated import already registered[\s\S]*owned by first/);
  assert.equal(await readFile(output, 'utf8'), source);
});

test('a manifest plugin selects a test entry before bundling without changing the authored manifest', async (t) => {
  const { root, config, configPath } = await fixture(t);
  const manifestPath = path.join(root, 'packs/BP/manifest.json');
  const original = await readFile(manifestPath, 'utf8');

  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), 'export const mode = "production";');
  await writeFile(path.join(root, 'packs/BP/scripts/tests.ts'), 'export const mode = "tests";');
  await writeFile(path.join(root, 'manifest-plugin.ts'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      const file = path.join(context.packs.behaviorPack, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.modules[0].entry = 'scripts/tests.js';
      await writeFile(file, JSON.stringify(manifest));
    }
  `);
  config.bedrockCore.plugins = { manifest: { module: './manifest-plugin.ts' } };
  config.bedrockCore.profiles.default.steps = [{ plugin: 'manifest', before: 'bundler' }];
  await writeFile(configPath, JSON.stringify(config));
  const result = await runBuild({ configPath, logger: {} });
  const output = await readFile(path.join(result.outputPaths.behaviorPack, 'scripts/tests.js'), 'utf8');

  assert.match(output, /tests/);
  assert.doesNotMatch(output, /production/);
  assert.equal(JSON.parse(await readFile(path.join(result.outputPaths.behaviorPack, 'manifest.json'), 'utf8')).modules[0].entry, 'scripts/tests.js');
  assert.equal(await readFile(manifestPath, 'utf8'), original);
  assert.equal(result.dependencies.includes(manifestPath), true);
});

test('JavaScript manifest entries bundle in place after all shared inputs are read', async (t) => {
  const { root, configPath } = await fixture(t);
  const manifest = manifestFor('script');

  manifest.modules.push(manifestFor('script', 'scripts/other.js').modules[0]);
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifest));
  const main = path.join(root, 'packs/BP/scripts/main.js');
  const original = 'export const value = 23;';

  await writeFile(main, original);
  await writeFile(path.join(root, 'packs/BP/scripts/other.js'), 'export { value } from "./main.js";');
  const result = await runBuild({ configPath, logger: {} });

  for (const entry of ['main', 'other']) {
    const executable = path.join(root, `${entry}.mjs`);

    await writeFile(executable, await readFile(path.join(result.outputPaths.behaviorPack, `scripts/${entry}.js`), 'utf8'));
    assert.equal((await import(pathToFileURL(executable).href)).value, 23);
  }

  assert.equal(await readFile(main, 'utf8'), original);
});

test('ambiguous TypeScript sources fail without choosing a different entry', async (t) => {
  const { root, configPath } = await fixture(t);

  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), 'export const value = 1;');
  await writeFile(path.join(root, 'packs/BP/scripts/main.tsx'), 'export const value = 2;');
  await assert.rejects(runBuild({ configPath, logger: {} }), /ambiguous sources/);
});
