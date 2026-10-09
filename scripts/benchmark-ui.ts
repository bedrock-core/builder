import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, glob, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runBuild } from '../src/run.ts';

const [source, dependencies, limitArgument] = process.argv.slice(2);
const limit = limitArgument === undefined ? Infinity : Number(limitArgument);

if (!source || !dependencies) {
  throw new Error('Usage: yarn node scripts/benchmark-ui.ts <fixture-project> <project-with-node_modules> [screen-limit]');
}

if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) {
  throw new Error('screen-limit must be a positive integer');
}

const root = await mkdtemp(path.join(tmpdir(), 'builder-ui-benchmark-'));

try {
  await cp(path.resolve(source, 'packs/BP'), path.join(root, 'packs/BP'), { recursive: true });
  await cp(path.resolve(source, 'packs/RP'), path.join(root, 'packs/RP'), { recursive: true });
  await symlink(path.resolve(dependencies, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifestFile = path.join(root, 'packs/BP/manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));

  // Measure the UI adapter independently of fixture harness script bundling.
  for (const module of manifest.modules) {
    if (module.type === 'script') {
      module.entry = 'scripts/benchmark.js';
    }
  }

  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(path.join(root, 'packs/BP/scripts/benchmark.js'), 'export const benchmark = true;');
  const screens: string[] = [];

  for await (const file of glob('packs/BP/scripts/**/*.screen.tsx', { cwd: root })) {
    screens.push(file);
  }

  screens.sort();

  for (const file of screens.slice(limit)) {
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);

    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await unlink(target);
  }

  if (Number.isFinite(limit)) {
    screens.length = Math.min(screens.length, limit);
  }

  assert.ok(screens.length > 0, 'The fixture project must contain screens');
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify({
    name: '@bedrock-core UI benchmark', authors: [], targetVersion: '1.26.50',
    namespace: 'drav0011_ui_tests', packs: { logic: './packs/BP', assets: './packs/RP' },
    bedrockCore: {
      formatVersion: '1.0.0', profiles: {
        default: {
          stages: { 'generator': false, 'guides': false, 'i18n': false, 'bundler': false, 'ui-compiler': { testMetadata: true, pretty: { size: 2 } } },
          export: { logic: './dist/BP', assets: './dist/RP' },
        },
      },
    },
  }));

  const measure = async (label: string) => {
    const start = performance.now();
    const result = await runBuild({
      configPath,
      logger: { info() {}, warn: console.warn, error: console.error },
    });
    const records = result.compilations.filter(record => record.id.startsWith('ui-compiler/screen:'));
    const executed = records.filter(record => record.status === 'executed').length;
    const seconds = (performance.now() - start) / 1000;

    console.log(JSON.stringify({ label, seconds: Number(seconds.toFixed(2)), executed, reused: records.length - executed }));

    return result;
  };

  const emitted = async (result: Awaited<ReturnType<typeof runBuild>>) => {
    const values: Record<string, string> = {};

    for await (const file of glob(['ui/**/*.json', 'texts/*.{lang,json}', 'bedrock-core/test-metadata.json'], { cwd: result.outputPaths.assets! })) {
      values[file] = createHash('sha256').update(await readFile(path.join(result.outputPaths.assets!, file))).digest('hex');
    }

    return values;
  };

  console.log(JSON.stringify({ screens: screens.length, root }));
  const cold = await measure('cold');
  const cacheDirectory = path.join(root, '.bedrock-core/cache/build', createHash('sha256').update('default').digest('hex'));
  const index = JSON.parse(await readFile(path.join(cacheDirectory, 'files.json'), 'utf8')) as { files: Record<string, string> };

  assert.equal(Object.keys(index.files).filter(id => id.startsWith('ui-compiler/screen:')).length, screens.length);
  const initial = await emitted(cold);
  const warm = await measure('unchanged');

  assert.deepEqual(await emitted(warm), initial);
  assert.equal(cold.compilations.filter(record => record.id.startsWith('ui-compiler/screen:')).length, screens.length);
  assert.equal(warm.compilations.filter(record => record.id.startsWith('ui-compiler/screen:') && record.status === 'executed').length, 0);
  const before = await emitted(warm);
  const changedFile = path.join(root, screens[0]!);
  const content = await readFile(changedFile, 'utf8');

  await writeFile(changedFile, `${content}\nexport const benchmarkRevision = 1;\n`);
  const changed = await measure('one-screen-edit');

  assert.equal(changed.compilations.filter(record => record.id.startsWith('ui-compiler/screen:') && record.status === 'executed').length, 1);
  assert.deepEqual(await emitted(changed), before);
} finally {
  await rm(root, { recursive: true, force: true });
}
