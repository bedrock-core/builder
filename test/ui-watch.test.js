import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { projectFor } from '../test-support/project.js';
import { installUi } from '../test-support/ui.js';
import { watchBuild } from '../src/watch.ts';

async function waitFor(condition) {
  const deadline = Date.now() + 15000;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a UI watch build');
    }

    await delay(20);
  }
}

test('UI watch reuses screens for script and asset edits, rebuilds affected screens and recovers from compiler errors', { timeout: 30000 }, async (t) => {
  const project = await projectFor(t, { cleanup: false });
  const controller = new AbortController();
  const results = [];
  const errors = [];
  const scripts = path.join(project.project, 'packs/gameplay/scripts');

  await installUi(project.project);
  project.config.bedrockCore.profiles.default.watch = { debounceMs: 30 };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await writeFile(path.join(scripts, 'data.json'), '{"text":"First"}');
  await writeFile(path.join(scripts, 'affected.screen.tsx'), `import { Screen, Text } from '@bedrock-core/ui'; import data from './data.json'; export default function Page() { return <Screen><Text>{data.text}</Text></Screen>; }`);
  await writeFile(path.join(scripts, 'unrelated.screen.tsx'), `import { Screen, Text } from '@bedrock-core/ui'; export default function Page() { return <Screen><Text>Stable</Text></Screen>; }`);
  const watching = watchBuild({
    configPath: project.configPath, signal: controller.signal, logger: {},
    onBuild(result) { results.push(result); },
    onError(error) { errors.push(error); },
  });

  t.after(async () => {
    controller.abort();

    try {
      await watching;
    } finally {
      await project.dispose();
    }
  });
  const rebuilt = result => result.compilations.filter(item => item.id.startsWith('ui-compiler/screen:') && item.status === 'executed').map(item => item.id);

  await waitFor(() => results.length === 1 || errors.length > 0);
  assert.deepEqual(errors, []);
  await writeFile(path.join(scripts, 'main.ts'), 'export const value = 2;');
  await waitFor(() => results.length >= 2);
  assert.deepEqual(rebuilt(results.at(-1)), []);
  let count = results.length;

  await writeFile(path.join(project.project, 'packs/visuals/asset.json'), '{"value":2}');
  await waitFor(() => results.length > count);
  assert.deepEqual(rebuilt(results.at(-1)), []);
  count = results.length;
  await writeFile(path.join(scripts, 'affected.screen.tsx'), 'export default function broken(');
  await waitFor(() => errors.length > 0);
  assert.equal(results.length, count);
  assert.match(await readFile(path.join(results.at(-1).outputPaths.visuals, 'ui/core-ui/screens/flow_test/affected.json'), 'utf8'), /First/);
  await writeFile(path.join(scripts, 'affected.screen.tsx'), `import { Screen, Text } from '@bedrock-core/ui'; import data from './data.json'; export default function Page() { return <Screen><Text>{data.text}</Text></Screen>; }`);
  await writeFile(path.join(scripts, 'data.json'), '{"text":"Second"}');
  await waitFor(() => results.length > count);
  assert.deepEqual(rebuilt(results.at(-1)), ['ui-compiler/screen:affected']);
  assert.match(await readFile(path.join(results.at(-1).outputPaths.visuals, 'ui/core-ui/screens/flow_test/affected.json'), 'utf8'), /Second/);
  count = results.length;
  await delay(400);
  assert.equal(results.length, count, 'Generated declarations and pack output must not cause watch loops');
});
