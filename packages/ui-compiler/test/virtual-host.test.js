import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeUiHosts } from '../src/hosts.ts';

test('virtual protocols belong to the selected behavior pack without a world host', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'builder-virtual-host-'));

  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^builder-virtual-host-/);
    await rm(root, { recursive: true, force: true });
  });
  const owner = path.join(root, 'owner');
  const other = path.join(root, 'other');

  await mkdir(owner);
  await mkdir(other);
  const item = { 'format_version': '1.26.0', 'minecraft:item': { description: { identifier: 'example:protocol' } } };
  const linked = {
    screens: [{ name: 'virtual', addon: 'example', host: { kind: 'virtual' } }],
    items: { example: [{ role: 'protocol', document: item }] },
  };
  const files = await writeUiHosts([other, owner], linked, {}, owner);

  assert.deepEqual(files, [path.join(owner, 'items/core-ui/example/protocol.json')]);
  assert.deepEqual(JSON.parse(await readFile(files[0], 'utf8')), item);
  assert.deepEqual(await readdir(other), []);
  assert.deepEqual(await readdir(owner), ['items']);
});
