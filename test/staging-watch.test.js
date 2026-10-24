import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { watchBuild } from '../src/watch.ts';
import { projectFor } from '../test-support/project.js';
import { put } from '../test-support/i18n.js';

async function waitFor(condition) {
  const deadline = Date.now() + 10000;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a watch build');
    }

    await delay(20);
  }
}

test('watch ignores staging exclusions and observes them after configuration changes', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.staging = { exclude: ['cache'] };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await put(project.project, 'cache/data.json', '{"value":1}');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({
    configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await put(project.project, 'cache/data.json', '{"value":2}');
  await delay(200);
  assert.equal(results.length, 1);
  project.config.bedrockCore.staging.exclude = [];
  await writeFile(project.configPath, JSON.stringify(project.config));
  await waitFor(() => results.length >= 2);
  await delay(100);
  const before = results.length;

  await put(project.project, 'cache/data.json', '{"value":3}');
  await waitFor(() => results.length > before);
  assert.deepEqual(errors, []);
});
