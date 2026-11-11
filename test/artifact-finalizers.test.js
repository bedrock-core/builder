import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';

async function fixture(t) {
  const project = await projectFor(t);

  await writeFile(path.join(project.project, 'packs/gameplay/private.json'), '{}');
  await writeFile(path.join(project.project, 'packs/gameplay/facts.json'), '{"value":1}');
  await writeFile(path.join(project.project, 'producer.ts'), `
    import { access, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      const pack = context.packs.gameplay;
      const privateFile = path.join(pack, 'private.json');
      const output = path.join(pack, 'receipt.json');
      await writeFile(output, '{}');
      await context.registerArtifact('receipt', output);
      context.excludeFromExport(privateFile);
      context.finalizeArtifact('receipt', async artifact => {
        await access(privateFile).then(() => { throw new Error('Source was not excluded'); }, error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (settings.fail) throw new Error('Receipt finalization failed');
        const facts = JSON.parse(await readFile(path.join(pack, 'facts.json'), 'utf8'));
        await writeFile(artifact.path, settings.invalid ? '{' : JSON.stringify({ value: facts.value }));
      });
      if (settings.duplicate) context.finalizeArtifact('receipt', () => {});
    }
  `);
  await writeFile(path.join(project.project, 'edit.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context, settings) {
      if (settings.borrow) context.finalizeArtifact('receipt', () => {});
      await writeFile(path.join(context.packs.gameplay, 'facts.json'), '{"value":2}');
    }
  `);
  project.config.bedrockCore.plugins = { producer: { module: './producer.ts' }, edit: { module: './edit.ts' } };
  project.config.bedrockCore.profiles.default.steps = [
    { plugin: 'producer', after: 'prepare', settings: {} },
    { plugin: 'edit', before: 'export', settings: {} },
  ];
  project.save = () => writeFile(project.configPath, JSON.stringify(project.config));
  await project.save();

  return project;
}

test('artifact finalization reads final staged inputs after hooks and exclusions', async (t) => {
  const project = await fixture(t);
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'receipt.json'), 'utf8')), { value: 2 });
  assert.equal(await readFile(path.join(project.project, 'packs/gameplay/facts.json'), 'utf8'), '{"value":1}');
});

for (const [setting, message] of [['fail', /Receipt finalization failed/], ['invalid', /Invalid pack content/]]) {
  test(`a finalizer's ${setting} result prevents publication and preserves earlier output`, async (t) => {
    const project = await fixture(t);
    const options = { configPath: project.configPath, logger: {} };
    const first = await runBuild(options);
    const output = path.join(first.outputPaths.gameplay, 'receipt.json');
    const previous = await readFile(output, 'utf8');

    project.config.bedrockCore.profiles.default.steps[0].settings[setting] = true;
    await project.save();
    await assert.rejects(runBuild(options), message);
    assert.equal(await readFile(output, 'utf8'), previous);
  });
}

for (const [step, setting, message] of [[0, 'duplicate', /one finalizer/], [1, 'borrow', /owned by this invocation/]]) {
  test(`artifact finalization rejects ${setting} registration`, async (t) => {
    const project = await fixture(t);

    project.config.bedrockCore.profiles.default.steps[step].settings[setting] = true;
    await project.save();
    await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), message);
  });
}
