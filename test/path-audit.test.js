import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('../bin/builder.ts', import.meta.url));

function audit(...args) {
  return spawnSync(process.execPath, [builder, 'audit-paths', ...args], { encoding: 'utf8' });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'builder-path-audit-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

async function createFiles(directory, files) {
  for (const file of files) {
    const target = path.join(directory, file);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{}');
  }
}

test('audits final pack paths and reports cooperative asset-folder findings', async (t) => {
  const directory = await fixture(t);
  const atLimit = `${'a'.repeat(95)}.json`;
  const overLimit = `${'b'.repeat(96)}.json`;
  const deep = 'a/b/c/d/e/f/g/h/i/file.json';
  const misplaced = 'textures/other/demo/icon.png';
  const loose = 'sounds/loose.ogg';

  await createFiles(directory, [
    'manifest.json', atLimit, overLimit, deep, 'a/b/c/d/e/f/g/h/file.json', misplaced, loose,
    'textures/example/demo/icon.png', 'textures/example/common/icon.png',
    'textures/item_texture.json', 'sounds/sound_definitions.json', 'functions/tick.json',
  ]);
  const result = audit(directory, '--creator', 'example', '--pack', 'demo');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.limits, { length: 100, depth: 8 });
  assert.equal(report.packs[0].path, '.');
  assert.equal(report.packs[0].files, 12);
  assert.deepEqual(report.packs[0].longest, { path: overLimit, length: 101 });
  assert.deepEqual(report.packs[0].findings.map(({ rule, path }) => [rule, path]).sort(), [
    ['asset-folder', loose], ['asset-folder', misplaced], ['path-depth', deep], ['path-length', overLimit],
  ]);
});

test('counts custom pack names in an unpacked add-on and applies the selected budget', async (t) => {
  const directory = await fixture(t);
  const file = `${'a'.repeat(75)}.json`;

  await createFiles(path.join(directory, 'behavior_packs', 'BP'), ['manifest.json', file]);
  await createFiles(path.join(directory, 'resource_packs', 'demo'), ['manifest.json', file]);
  const result = audit(directory, '--max-length', '80');

  assert.equal(result.status, 0, result.stderr);
  const { packs } = JSON.parse(result.stdout);

  assert.deepEqual(packs.map(pack => [pack.path, pack.longest.length, pack.findings.map(finding => finding.path)]), [
    ['behavior_packs/BP', 80, []],
    ['resource_packs/demo', 85, [`demo/${file}`]],
  ]);
});

test('rejects incomplete options and links inside a pack', async (t) => {
  const directory = await fixture(t);
  const pack = path.join(directory, 'pack');
  const outside = path.join(directory, 'outside');

  await createFiles(pack, ['manifest.json']);
  await mkdir(outside);
  const invalid = audit(pack, '--creator', 'example');

  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /specified together/);
  await symlink(outside, path.join(pack, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = audit(pack);

  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /cannot follow a link/);
});
