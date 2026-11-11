import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectFor } from '../test-support/project.js';
import { runBuild } from '../src/run.ts';
import { bundleScripts } from '../packages/bundler/src/index.ts';
import { run as runBundler } from '../packages/bundler/src/plugin.ts';

function loader(file, tracked, resolveOnly = false) {
  return {
    name: 'tracked-fixture',
    setup(build) {
      build.onResolve({ filter: /^virtual:fixture$/ }, () => ({ path: 'fixture', namespace: 'fixture-virtual', ...(resolveOnly ? { watchFiles: [file] } : {}) }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-virtual' }, () => ({
        contents: 'export const value = ' + Number(readFileSync(file, 'utf8')) + ';',
        loader: 'js',
        ...(tracked ? { watchFiles: [file] } : {}),
      }));
    },
  };
}

test('only opted-in virtual loaders with their own file dependencies permit cache reuse', async (t) => {
  const project = await projectFor(t);
  const file = path.join(project.project, 'value.txt');
  const entry = path.join(project.project, 'packs/gameplay/scripts/main.ts');

  await writeFile(file, '7');
  await writeFile(entry, 'export { value } from "virtual:fixture";');
  const options = { root: project.project, entry, outfile: 'virtual.js', cachePlugins: true };
  const tracked = await bundleScripts({ ...options, plugins: [loader(file, true)] });

  assert.equal(tracked.cacheable, true);
  assert(tracked.watchFiles.includes(file));
  assert(![...tracked.inputs, ...tracked.watchFiles].some(input => input.includes('fixture-virtual:')));
  assert.equal((await bundleScripts({ ...options, plugins: [loader(file, false)] })).cacheable, false);
  assert.equal((await bundleScripts({ ...options, plugins: [loader(file, false, true)] })).cacheable, false);
  assert.equal((await bundleScripts({ ...options, cachePlugins: false, plugins: [loader(file, true)] })).cacheable, false);
});

test('tracked virtual runtime contributions reuse warm bundles and invalidate on source edits', async (t) => {
  const project = await projectFor(t);
  const file = path.join(project.project, 'value.txt');

  await writeFile(path.join(project.project, 'package.json'), '{"type":"module"}');
  await writeFile(file, '7');
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export { value } from "virtual:fixture";');
  const options = {
    configPath: project.configPath, logger: {}, stages: {
      bundler(context, settings) {
        context.registerBundleExtension({ id: 'fixture:virtual', version: '1', packs: ['gameplay'], cache: true, plugins: [loader(file, true)] });

        return runBundler(context, settings);
      },
    },
  };
  const first = await runBuild(options);
  const initial = await import(pathToFileURL(path.join(first.outputPaths.gameplay, 'scripts/main.js')).href);
  const warm = await runBuild(options);

  assert.equal(initial.value, 7);
  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  await writeFile(file, '8');
  const changed = await runBuild(options);
  const updated = await import(pathToFileURL(path.join(changed.outputPaths.gameplay, 'scripts/main.js')).href + '?updated');

  assert.equal(changed.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.equal(updated.value, 8);
  assert.equal(await readFile(file, 'utf8'), '8');
});
