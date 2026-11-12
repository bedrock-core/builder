import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkConsumer, publishSnapshot, verifyInstalledSnapshot } from './local-packages.mjs';
import { startRegistry, stopRegistry } from './local-registry.mjs';

async function repository(directory, manifest, files) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', packageManager: 'yarn@4.16.0', workspaces: ['.'], ...manifest }));

  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }

  execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
  execFileSync('git', ['-C', directory, 'add', '.'], { windowsHide: true, stdio: 'pipe' });
}

test('registry consumers receive successive dirty-source snapshots with checked archive bytes', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'core-local-packages-test-'));
  const directory = path.join(root, 'registry');

  t.after(async () => {
    await stopRegistry(directory);
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  await startRegistry({ directory, port: 0, offline: true });
  const producer = path.join(root, 'producer');
  const consumer = path.join(root, 'consumer');
  const name = '@bedrock-core/registry-test-' + randomBytes(4).toString('hex');

  await repository(producer, { name, version: '1.0.0', exports: './index.js', files: ['index.js'], scripts: { build: 'node --check index.js' } }, {
    'index.js': 'export const marker = "one";\n',
    '.changeset/config.json': JSON.stringify({ changelog: false, commit: false, access: 'public', baseBranch: 'main',
      fixed: [], linked: [], updateInternalDependencies: 'patch', ignore: [] }),
  });
  await writeFile(path.join(producer, 'index.js'), 'export const marker = "two";\n');
  await writeFile(path.join(producer, 'untracked.txt'), 'included working-tree input');
  await writeFile(path.join(producer, '.env'), 'PRIVATE_LOCAL_VALUE=excluded');
  await repository(consumer, { name: 'local-consumer', private: true, scripts: { check: 'node check.mjs' } }, {
    'check.mjs': `import assert from 'node:assert/strict'; import { marker } from '${name}'; assert.equal(marker, 'two');\n`,
  });
  const originalProducer = await readFile(path.join(producer, 'package.json'));
  const originalConsumer = await readFile(path.join(consumer, 'package.json'));

  await assert.rejects(publishSnapshot({ repository: producer, build: 'release', directory }), /not a publication script/);
  const first = await publishSnapshot({ repository: producer, build: 'build', directory });

  await assert.rejects(access(path.join(first.directory, 'source/.env')));
  assert.equal(await readFile(path.join(first.directory, 'source/untracked.txt'), 'utf8'), 'included working-tree input');
  const checked = await checkConsumer({ receiptFile: first.receiptFile, consumer, check: 'check', directory });

  assert.equal(checked.status, 'passed');
  assert.equal(checked.packages[0].version, first.packages[0].version);
  await writeFile(path.join(producer, 'index.js'), 'export const marker = "three";\n');
  await writeFile(path.join(consumer, 'check.mjs'), `import assert from 'node:assert/strict'; import { marker } from '${name}'; assert.equal(marker, 'three');\n`);
  const second = await publishSnapshot({ repository: producer, build: 'build', directory });

  assert.notEqual(second.packages[0].version, first.packages[0].version);
  assert.notEqual(second.source.sha256, first.source.sha256);
  const repeated = await checkConsumer({ receiptFile: second.receiptFile, consumer, check: 'check', directory });

  assert.equal(repeated.status, 'passed');
  assert.ok((await readFile(path.join(producer, 'package.json'))).equals(originalProducer));
  assert.ok((await readFile(path.join(consumer, 'package.json'))).equals(originalConsumer));
  await writeFile(second.packages[0].file, 'changed archive');
  await assert.rejects(verifyInstalledSnapshot(second, repeated.project), /Snapshot archive changed/);
  await assert.rejects(checkConsumer({ receiptFile: second.receiptFile, consumer, check: 'check', directory }), /Snapshot archive changed/);
});
