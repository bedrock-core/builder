import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { safe } from '../../bedrock-types/src/files.ts';
import { assetVersion, compareVersions, readAssetRelease, readReleases, registerAssetRelease, type AssetInputFiles } from '../src/releases.ts';
import { releaseTag } from '../src/pack.ts';
import { writeDistDiff } from '../src/diff.ts';

test('maps Mojang Samples tags to stable and Preview package versions', async () => {
  assert.equal(assetVersion('v1.26.60.5'), '26.60.5');
  assert.equal(assetVersion('v1.26.60.30-preview'), '26.60.30-preview');
  assert.throws(() => assetVersion('v1.26.60'), /Unsupported/);
  assert.ok(compareVersions('26.60.10', '26.60.9') > 0);
  assert.ok(compareVersions('26.60.5', '26.60.5-preview') > 0);
  assert.equal(releaseTag('26.60.30-preview', { latest: '26.60.5' }), 'preview');
  assert.equal(releaseTag('26.50.4', { latest: '26.60.5' }), 'mc-26.50.4');
  assert.equal(releaseTag('26.60.29-preview', { preview: '26.60.30-preview' }), 'mc-26.60.29-preview');
  assert.equal((await readAssetRelease()).version, '26.60.30-preview');
  await assert.rejects(readAssetRelease('0.1.0'), /Unknown Asset Maps release/);
});

test('registers additional editions without replacing earlier source snapshots', async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), 'asset-maps-releases-'));

  t.after(async () => {
    await safe(tmpdir(), output);
    await rm(output, { recursive: true, force: true });
  });
  const file = path.join(output, 'releases.json');
  const preview = (await readAssetRelease()).source;
  const stable = { ...preview, bedrock: { ...preview.bedrock, tag: 'v1.26.60.5', minecraft: '1.26.60.5', channel: 'stable' as const } };
  const snapshot = (source: typeof preview): AssetInputFiles => ({
    'sources.json': Buffer.from(JSON.stringify(source)),
    'native-states.json': Buffer.from(JSON.stringify({ version: source.bedrock.minecraft })),
    'native-bindings.json': Buffer.from('{}'), 'renderer-profiles.json': Buffer.from('{}'), 'texture-rules.json': Buffer.from('{}'),
  });

  await writeFile(file, '{}\n');
  assert.equal(await registerAssetRelease(preview, snapshot(preview), file), true);
  assert.equal(await registerAssetRelease(stable, snapshot(stable), file), true);
  assert.equal(await registerAssetRelease(stable, snapshot(stable), file), false);
  assert.deepEqual(Object.keys(await readReleases(file)), ['26.60.5', '26.60.30-preview']);
  const [first, second] = await Promise.all([readAssetRelease('26.60.30-preview', file), readAssetRelease('26.60.5', file)]);

  assert.deepEqual(first.source, preview);
  assert.deepEqual(second.source, stable);
  assert.equal(await readFile(path.join(first.directory, 'native-states.json'), 'utf8'), '{"version":"1.26.60.30"}');
  assert.equal(await readFile(path.join(second.directory, 'native-states.json'), 'utf8'), '{"version":"1.26.60.5"}');
  await assert.rejects(registerAssetRelease(stable, { ...snapshot(stable), 'sources.json': Buffer.from('{}') }, file), /already exist/);
});

test('writes a comparison of added, changed and removed release documents', async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), 'asset-maps-release-diff-'));

  t.after(async () => {
    await safe(tmpdir(), output);
    await rm(output, { recursive: true, force: true });
  });
  const before = path.join(output, '26.50.4', 'dist');
  const after = path.join(output, '26.60.5', 'dist');

  await Promise.all([mkdir(before, { recursive: true }), mkdir(after, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(before, 'coverage.json'), '{"gaps":2}\n'),
    writeFile(path.join(after, 'coverage.json'), '{"gaps":0}\n'),
    writeFile(path.join(before, 'removed.json'), '{}\n'),
    writeFile(path.join(after, 'added.json'), '{}\n'),
  ]);
  const diff = await writeDistDiff('26.50.4', '26.60.5', before, after);

  assert.deepEqual(diff, { from: '26.50.4', to: '26.60.5', added: ['added.json'], removed: ['removed.json'], changed: ['coverage.json'] });
  assert.match(await readFile(path.join(path.dirname(after), 'dist.patch'), 'utf8'), /\+"?\{"gaps":0\}/);
});
