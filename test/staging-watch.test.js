import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watchBuild } from '../src/watch.ts';
import { projectFor, put } from '../test-support/project.js';

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

  project.config.bedrockCore.staging = { include: ['cache'], exclude: ['cache'] };
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

test('watch ignores unrelated directories and reconnects after a shared input directory is replaced', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.watch = { debounceMs: 25 };
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { value } from "../../../shared/value.ts";');
  await put(project.project, 'shared/value.ts', 'export const value = 1;');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({ configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); } });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => results.length === 1);
  await put(project.project, 'server/worlds/world/db/change', 'unrelated world data');
  await put(project.project, 'shared/unused.ts', 'throw new Error("unused");');
  await delay(250);
  assert.equal(results.length, 1);
  await rename(path.join(project.project, 'shared'), path.join(project.project, 'previous-shared'));
  await put(project.project, 'shared/value.ts', 'export const value = 2;');
  await waitFor(() => results.length >= 2);
  await delay(150);
  const before = results.length;

  await put(project.project, 'shared/value.ts', 'export const value = 3;');
  await waitFor(() => results.length > before);
  assert.deepEqual(errors, []);
});

test('watch recovers when an unresolved shared import and a declared empty input directory are created', { timeout: 15000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.staging = { include: ['plugin-data'] };
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 25 };
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { value } from "../../../shared/new/value.ts";');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const watching = watchBuild({ configPath: project.configPath, signal: cancellation.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); } });

  t.after(async () => {
    cancellation.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  await waitFor(() => errors.length > 0);
  await put(project.project, 'shared/new/value.ts', 'export const value = 5;');
  await waitFor(() => results.length >= 1);
  let before = results.length;

  await mkdir(path.join(project.project, 'plugin-data'));
  await waitFor(() => results.length > before);
  await delay(150);
  before = results.length;
  await put(project.project, 'plugin-data/items.json', '{}');
  await waitFor(() => results.length > before);
});
