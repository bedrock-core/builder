import { manifestFor } from '../test-support/manifest.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBuild } from '../src/run.ts';

async function fixture(t, plugin, steps = [{ plugin: 'custom', after: 'prepare' }]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-test-')));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packs/BP'), { recursive: true });
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(manifestFor('data')));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'packs/BP/source.json'), '{"source":true}');
  await writeFile(path.join(root, 'dist/previous.txt'), 'previous successful export');
  await writeFile(path.join(root, 'dist/manifest.json'), await readFile(path.join(root, 'packs/BP/manifest.json')));
  await writeFile(path.join(root, 'plugin.ts'), plugin);
  const config = {
    name: 'Test',
    authors: [],
    namespace: 'test',
    targetVersion: '1.26.50',
    packs: { behaviorPack: './packs/BP' },
    bedrockCore: {
      formatVersion: '1.0.0',
      plugins: { custom: { module: './plugin.ts' } },
      profiles: { default: { steps, export: { behaviorPack: './dist' } } },
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
    import { writeFile, readFile, realpath } from 'node:fs/promises';
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
    JSON.parse(await readFile(path.join(result.outputPaths.behaviorPack, 'generated.json'), 'utf8')),
    { item: 'custom' },
  );
  assert.deepEqual((await readdir(path.join(project.root, 'packs/BP'))).sort(), ['manifest.json', 'source.json']);
  assert.ok(result.artifacts.some(artifact => artifact.id === 'items'));
  assert.equal(result.dependencies.includes(path.join(project.root, 'plugin.ts')), true);
  await assert.rejects(readFile(path.join(result.outputPaths.behaviorPack, 'previous.txt')), { code: 'ENOENT' });
});

test('targeted modules receive one current pack and record distinct artifact owners', async (t) => {
  const project = await fixture(t, `
    export const requirements = { modules: ['resources'] };
    import { writeFile, realpath } from 'node:fs/promises';
    import path from 'node:path';
    const seen = [];
    export async function run(ctx, settings) {
      seen.push(ctx.pack.id);
      const file = path.join(ctx.packs[ctx.pack.id], 'generated.json');
      await writeFile(file, '{}');
      await ctx.registerArtifact('generated:' + ctx.pack.id, file, { importAs: '@generated/' + ctx.pack.id });
      await writeFile(file, JSON.stringify({ id: ctx.pack.id, kind: ctx.pack.kind, packs: Object.keys(ctx.packs), outputs: Object.keys(ctx.outputPaths), seen: [...seen], imports: Object.keys(ctx.generatedImports), settings }));
    }
  `);

  for (const id of ['assets', 'gallery']) {
    const directory = path.join(project.root, 'packs', id);

    await mkdir(directory);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifestFor('resources')));
    project.config.packs[id] = './packs/' + id;
    project.config.bedrockCore.profiles.default.export[id] = './built/' + id;
  }

  project.config.bedrockCore.profiles.default.steps[0].settings = { amount: 4 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild(project.options);

  for (const [index, id] of ['assets', 'gallery'].entries()) {
    assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths[id], 'generated.json'), 'utf8')), {
      id, kind: 'resource', packs: [id], outputs: [id], seen: ['assets', 'gallery'].slice(0, index + 1), imports: ['@bedrock-core/generated/project', ...['@generated/assets', '@generated/gallery'].slice(0, index + 1)], settings: { amount: 4 },
    });
    await assert.rejects(readFile(path.join(project.root, 'packs', id, 'generated.json')), { code: 'ENOENT' });
  }

  await assert.rejects(readFile(path.join(result.outputPaths.behaviorPack, 'generated.json')), { code: 'ENOENT' });
  assert.deepEqual(result.artifacts.filter(artifact => artifact.id.startsWith('generated:')).map(artifact => ({ id: artifact.id, owner: artifact.owner })), [
    { id: 'generated:assets', owner: 'custom:1:assets' },
    { id: 'generated:gallery', owner: 'custom:1:gallery' },
  ]);
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
test('unsafe output fails before plugins run', async (t) => {
  const project = await fixture(t, 'throw new Error("plugin loaded");');

  project.config.bedrockCore.profiles.default.export.behaviorPack = './packs/BP';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild(project.options), /separate directories/);
  await preservation(project.root);
});
test('a destination lock blocks overlapping writes', async (t) => {
  const project = await fixture(t, 'export async function run() {}');
  const lock = path.join(project.root, 'dist.builder-lock');

  await mkdir(lock);
  await assert.rejects(runBuild(project.options), { code: 'EEXIST' });
  assert.equal((await readdir(project.root)).includes('dist.builder-lock'), true);
});

test('artifact ownership accepts canonical workspaces beneath an aliased temporary directory', async (t) => {
  const project = await fixture(t, 'export async function run() {}');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-temp-alias-')));

  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'canonical');
  const alias = path.join(root, 'alias');

  await mkdir(directory);
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const previous = new Map(['TMP', 'TEMP', 'TMPDIR'].map(key => [key, process.env[key]]));

  try {
    for (const key of previous.keys()) {
      process.env[key] = alias;
    }

    const result = await runBuild(project.options);

    assert.ok(result.artifacts.some(artifact => artifact.id === 'project:metadata'));
    assert.equal(await readFile(path.join(result.outputPaths.behaviorPack, 'source.json'), 'utf8'), '{"source":true}');
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
