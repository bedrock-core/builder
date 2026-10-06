import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileCache } from '../src/file-cache.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-files-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'compiler.ts'), 'version 1');

  return { root, directory: path.join(root, 'cache'), roots: { project: root } };
}

test('file outputs restore to a replacement workspace with discovered inputs', async (t) => {
  const options = await fixture(t);
  const firstRoot = path.join(options.root, 'first');
  const secondRoot = path.join(options.root, 'second');

  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const dependency = path.join(options.root, 'compiler.ts');
  const first = await createFileCache({ ...options, roots: { project: firstRoot } });

  await first.reuse('screen', {
    inputs: [],
    async run() {
      const file = path.join(firstRoot, 'screen.json');

      await writeFile(file, '{"text":"hello"}');

      return { value: { name: 'screen' }, inputs: [dependency], files: [file] };
    },
  });
  await first.save();
  const second = await createFileCache({ ...options, roots: { project: secondRoot } });
  const result = await second.reuse('screen', {
    inputs: [],
    run() { throw new Error('Unchanged unit must not execute'); },
  });

  assert.equal(result.cached, true);
  assert.deepEqual(result.value, { name: 'screen' });
  assert.deepEqual(result.inputs, [dependency]);
  assert.deepEqual(result.files, [path.join(secondRoot, 'screen.json')]);
  assert.equal(await readFile(result.files[0], 'utf8'), '{"text":"hello"}');
});

test('failed and cancelled compilations do not replace a successful cache', async (t) => {
  const options = await fixture(t);
  const first = await createFileCache(options);

  await first.reuse('unit', { inputs: [], key: 1, run: () => ({ value: 1 }) });
  await first.save();
  const previous = await readFile(path.join(options.directory, 'files.json'), 'utf8');
  const failed = await createFileCache(options);

  await assert.rejects(failed.reuse('unit', {
    inputs: [], key: 2,
    run() {
      throw new Error('Failed');
    },
  }), /Failed/);
  assert.equal(await readFile(path.join(options.directory, 'files.json'), 'utf8'), previous);
  const signal = new AbortController();
  const cancelled = await createFileCache({ ...options, signal: signal.signal });

  await assert.rejects(cancelled.reuse('unit', {
    inputs: [], key: 2,
    run() {
      signal.abort(new Error('Cancelled'));

      return { value: 2 };
    },
  }), /Cancelled/);
  await assert.rejects(cancelled.save(), /Cancelled/);
  assert.equal(await readFile(path.join(options.directory, 'files.json'), 'utf8'), previous);
  assert.deepEqual(await readdir(options.directory), ['files.json']);
});

test('corrupt values rebuild, cache disabling bypasses reuse and duplicate IDs fail', async (t) => {
  const options = await fixture(t);
  const first = await createFileCache(options);

  await first.reuse('unit', { inputs: [], run: () => ({ value: { number: 1 } }) });
  await first.save();
  const file = path.join(options.directory, 'files.json');
  const record = JSON.parse(await readFile(file, 'utf8'));

  record.files.unit.value.number = 999;
  await writeFile(file, JSON.stringify(record));
  const second = await createFileCache(options);
  const result = await second.reuse('unit', { inputs: [], run: () => ({ value: { number: 2 } }) });

  assert.equal(result.cached, false);
  assert.deepEqual(result.value, { number: 2 });
  await assert.rejects(second.reuse('unit', { inputs: [], run: () => ({ value: 0 }) }), /unique/);
  await second.save();
  const disabled = await createFileCache({ ...options, enabled: false });

  assert.equal((await disabled.reuse('unit', { inputs: [], run: () => ({ value: 3 }) })).cached, false);
  await disabled.save();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).files.unit.value.number, 2);
});

test('non-JSON values cannot enter a cached record', async (t) => {
  const options = await fixture(t);
  const cache = await createFileCache(options);

  for (const [index, value] of [new Date(), new Map(), undefined, { callback() {} }].entries()) {
    await assert.rejects(cache.reuse(String(index), { inputs: [], run: () => ({ value }) }), /only JSON data/);
  }
});
