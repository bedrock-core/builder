import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registryOrigin, registryStatus, startRegistry, stopRegistry } from './local-registry.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'core-local-registry-test-'));

  t.after(async () => {
    await stopRegistry(directory);
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

test('publication rejects public, authenticated and path-prefixed registry destinations', () => {
  for (const endpoint of ['https://registry.npmjs.org', 'http://0.0.0.0:4873', 'http://localhost:4873',
    'http://127.0.0.1:4873/prefix', 'http://user:password@127.0.0.1:4873', 'http://127.0.0.1:4873/?other=true']) {
    assert.throws(() => registryOrigin(endpoint));
  }

  assert.equal(registryOrigin('http://127.0.0.1:4873/'), 'http://127.0.0.1:4873');
});

test('owned registry authenticates, rejects foreign shutdown and restarts with existing storage', { timeout: 40_000 }, async (t) => {
  const directory = await temporary(t);
  const first = await startRegistry({ directory, port: 0, offline: true });

  assert.equal((await registryStatus(directory)).pid, first.pid);
  assert.equal((await startRegistry({ directory, port: 0, offline: true })).id, first.id);
  const index = await fetch(first.endpoint);

  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const forbidden = await fetch(first.endpoint + '/-/bedrock-core/local-registry/stop', { method: 'POST' });

  assert.equal(forbidden.status, 403);
  assert.equal((await registryStatus(directory)).id, first.id);
  assert.equal(await stopRegistry(directory), true);
  assert.equal(await registryStatus(directory), undefined);
  const second = await startRegistry({ directory, port: 0, offline: true });

  assert.notEqual(second.id, first.id);
  assert.equal(await stopRegistry(directory), true);
  assert.equal(await stopRegistry(directory), false);
});

test('an occupied port leaves the existing service running', { timeout: 30_000 }, async (t) => {
  const directory = await temporary(t);
  const occupied = createServer((_request, response) => response.end('existing service'));

  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;

  await assert.rejects(startRegistry({ directory, port, offline: true }), /Registry exited/);
  assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'existing service');
});
