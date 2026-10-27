import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeUiResource } from '../packages/ui-compiler/src/output.ts';

test('Ore resources remain outside JSON UI definitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ore-resources-'));

  try {
    await writeUiResource(root, { screens: [], hooks: [], documents: [], lang: [], resources: [
      { file: 'hbui/core-ore-client.js', text: 'window.oreTest=true;' },
      { file: 'hbui/core-ore/demo.json', text: '{"schema":"core-ore-layout/1"}' },
    ] }, [], 'demo', {});
    assert.equal(await readFile(path.join(root, 'hbui/core-ore-client.js'), 'utf8'), 'window.oreTest=true;');
    const defs = JSON.parse(await readFile(path.join(root, 'ui/_ui_defs.json'), 'utf8'));

    assert(defs.ui_defs.every(file => file.startsWith('ui/')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Ore resource paths reject traversal and non-hbui output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ore-resource-path-'));

  try {
    for (const file of ['hbui/../escape.js', '../escape.js', 'hbui/inner\\escape.js']) {
      await assert.rejects(writeUiResource(root, { screens: [], hooks: [], documents: [], lang: [], resources: [{ file, text: 'x' }] }, [], 'demo', {}), /Invalid experimental UI resource path/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
