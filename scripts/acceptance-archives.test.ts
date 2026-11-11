import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { acceptanceArchives, archiveIntegrity, type AcceptanceArchiveIndex } from './acceptance-archives.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-acceptance-archives-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'archives/index.json');
  const bytes = Buffer.from('fixture candidate');
  const index: AcceptanceArchiveIndex = {
    sources: [{ repository: 'bedrock-core/ui', commit: 'a'.repeat(40) }],
    packages: [{ name: '@bedrock-core/ui', version: '1.0.0', file: 'ui.tgz', integrity: archiveIntegrity(bytes) }],
  };

  await mkdir(path.dirname(file));
  await writeFile(path.join(path.dirname(file), 'ui.tgz'), bytes);
  const save = () => writeFile(file, JSON.stringify(index));

  await save();

  return { root, file, index, save };
}

test('registry-only acceptance needs no candidate archive evidence', async () => {
  assert.deepEqual(await acceptanceArchives(undefined), { resolutions: {}, evidence: undefined });
});

test('candidate resolutions retain the checked package and source identities', async (t) => {
  const f = await fixture(t);
  const result = await acceptanceArchives(f.file);

  assert.deepEqual(result.resolutions, { '@bedrock-core/ui': `file:${path.join(f.root, 'archives/ui.tgz').replaceAll('\\', '/')}` });
  assert.deepEqual(result.evidence, f.index);
});

test('changed fixture archives cannot satisfy acceptance verification', async (t) => {
  const f = await fixture(t);

  await writeFile(path.join(f.root, 'archives/ui.tgz'), 'changed candidate');
  await assert.rejects(acceptanceArchives(f.file), /Acceptance archive changed/);
});

test('candidate fixtures cannot override Builder packages or escape the archive directory', async (t) => {
  const f = await fixture(t);

  for (const name of ['@bedrock-core/builder', '@bedrock-core/builder-plugin', '@minecraft/server']) {
    f.index.packages[0].name = name;
    await f.save();
    await assert.rejects(acceptanceArchives(f.file), /Unexpected or duplicate acceptance package/);
  }

  f.index.packages[0].name = '@bedrock-core/ui';

  for (const file of ['../ui.tgz', '..\\ui.tgz', '/ui.tgz', 'C:\\ui.tgz']) {
    f.index.packages[0].file = file;
    await f.save();
    await assert.rejects(acceptanceArchives(f.file), /Acceptance archive must be a filename/);
  }
});

test('candidate evidence requires unique packages and source commits', async (t) => {
  const f = await fixture(t);

  f.index.packages.push({ ...f.index.packages[0] });
  await f.save();
  await assert.rejects(acceptanceArchives(f.file), /Unexpected or duplicate acceptance package/);
  f.index.packages.pop();
  f.index.sources[0].commit = 'main';
  await f.save();
  await assert.rejects(acceptanceArchives(f.file), /repository commit identities/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.index);
});
