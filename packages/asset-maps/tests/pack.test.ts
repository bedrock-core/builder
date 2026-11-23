import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePackJson, readPackAssets } from '../src/sources/pack.ts';

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bc-vanilla-reader-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '__brarchive'), { recursive: true });

  return root;
}

function archive(name: string, content: string, offset = 0): Buffer {
  const text = Buffer.from(content), bytes = Buffer.alloc(16 + 256 + text.length);

  Buffer.from('7d2725b1a0527026', 'hex').copy(bytes);
  bytes.writeUInt32LE(1, 8);
  bytes[16] = Buffer.byteLength(name);
  bytes.write(name, 17);
  bytes.writeUInt32LE(offset, 16 + 248);
  bytes.writeUInt32LE(text.length, 16 + 252);
  text.copy(bytes, 16 + 256);

  return bytes;
}

test('parses pack comments and trailing commas while preserving comment-like string contents', () => {
  assert.deepEqual(parsePackJson('\uFEFF{/*comment*/"url":"a//b", "list":[1,],}'), { url: 'a//b', list: [1] });
  assert.throws(() => parsePackJson('{"broken":'), /invalid pack JSON/);
});

test('reads the known archive format and tracks its source without extracting files', async (t) => {
  const root = await directory(t), file = join(root, '__brarchive/models.brarchive');

  await writeFile(file, archive('entity/fixture.json', '{"minecraft:geometry":[]}'));
  const tracked: string[] = [];
  const resources = await readPackAssets(root, file => tracked.push(file));

  assert.deepEqual(resources.get('models/entity/fixture.json'), { 'minecraft:geometry': [] });
  assert.ok(tracked.includes(file));
  assert.ok(tracked.includes(root));
});

test('rejects truncated, escaping and out-of-range archive entries', async (t) => {
  const root = await directory(t), file = join(root, '__brarchive/models.brarchive');

  for (const bytes of [Buffer.from('tiny'), archive('../escape.json', '{}'), archive('safe.json', '{}', 100000)]) {
    await writeFile(file, bytes);
    await assert.rejects(readPackAssets(root), /unsupported vanilla archive|invalid vanilla archive/);
  }
});
