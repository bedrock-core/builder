import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBuild } from '../src/plan.ts';

const config = profile => ({
  bedrockCore: {
    formatVersion: '1.0.0',
    plugins: { custom: { module: './custom.ts' } },
    profiles: { default: profile },
  },
});

test('omitted stages keep automatic boundaries and explicit selections retain their settings', () => {
  assert.deepEqual(
    planBuild(config({ stages: { bundler: true } })).map(step => step.stage),
    ['prepare', 'manifest', 'generator', 'guides', 'i18n', 'ui-compiler', 'bundler', 'validate', 'export'],
  );
  const result = planBuild(config({ stages: { bundler: true, i18n: false } }));

  assert.equal(result.find(step => step.stage === 'generator').mode, 'auto');
  assert.equal(result.find(step => step.stage === 'bundler').mode, 'always');
  assert.equal(result.some(step => step.stage === 'i18n'), false);
});
test('hooks retain configuration order and validation follows final modifications', () => {
  const steps = [
    { plugin: 'custom', before: 'bundler', settings: { id: 1 } },
    { plugin: 'custom', before: 'bundler', settings: { id: 2 } },
    { plugin: 'custom', before: 'export' },
  ];
  const result = planBuild(config({ stages: { bundler: true }, steps }));

  assert.deepEqual(
    result.filter(step => step.kind === 'plugin').map(step => step.settings.id),
    [1, 2, undefined],
  );
  assert.equal(result.at(-3).plugin, 'custom');
  assert.equal(result.at(-2).stage, 'validate');
});

test('profile defaults reach automatic and explicit stages while stage overrides preserve false', () => {
  const project = config({
    pretty: { indent: 'tab', size: 1 }, debug: true,
    stages: { i18n: false, generator: true, manifest: { pretty: false }, bundler: { debug: false } },
  });
  const original = structuredClone(project);
  const steps = planBuild(project);

  assert.deepEqual(steps.find(step => step.stage === 'guides').settings, { pretty: { indent: 'tab', size: 1 }, debug: true });
  assert.equal(steps.find(step => step.stage === 'guides').mode, 'auto');
  assert.equal(steps.find(step => step.stage === 'generator').mode, 'always');
  assert.equal(steps.find(step => step.stage === 'manifest').settings.pretty, false);
  assert.equal(steps.find(step => step.stage === 'bundler').settings.debug, false);
  assert.equal(steps.some(step => step.stage === 'i18n'), false);
  assert.deepEqual(project, original);
});
test('disabled stage hooks and ambiguous boundaries are rejected', () => {
  assert.throws(
    () =>
      planBuild(
        config({ stages: { bundler: false }, steps: [{ plugin: 'custom', before: 'bundler' }] }),
      ),
    /Unavailable boundary/,
  );
  assert.throws(
    () =>
      planBuild(
        config({
          stages: { bundler: true },
          steps: [{ plugin: 'custom', before: 'bundler', after: 'bundler' }],
        }),
      ),
    /exactly one/,
  );
});
test('unknown stages, missing definitions and unsupported versions fail', () => {
  assert.throws(() => planBuild(config({ stages: { typo: true } })), /Unknown stage/);
  assert.throws(
    () => planBuild(config({ steps: [{ plugin: 'missing', after: 'prepare' }] })),
    /Missing plugin/,
  );
  assert.throws(() => planBuild({ bedrockCore: { formatVersion: '2.0.0' } }), /formatVersion/);
});

test('Node steps resolve named script definitions and pass invocation settings directly', () => {
  const project = config({ steps: [
    { plugin: 'generate', after: 'prepare', settings: { count: 2 }, arguments: ['first'] },
    { plugin: 'generate', after: 'prepare', settings: { count: 7 } },
    { plugin: 'custom', before: 'export', settings: { finish: true } },
  ] });
  const definition = { script: './filters/main.cjs', filterDir: '.', nodeArguments: ['--no-warnings'], folders: { RP: 'visuals' } };

  project.bedrockCore.plugins.generate = definition;
  const snapshot = structuredClone(project);
  const planned = planBuild(project).filter(step => step.kind === 'plugin');

  assert.deepEqual(planned[0], {
    kind: 'plugin', plugin: 'generate', ...definition, settings: { count: 2 }, arguments: ['first'], position: 'after', boundary: 'prepare',
  });
  assert.deepEqual(planned[1].settings, { count: 7 });
  assert.deepEqual(planned[1].arguments, []);
  assert.equal(planned[2].module, './custom.ts');
  assert.deepEqual(project, snapshot);
});

test('the planner rejects invalid entries and script arguments on native modules', () => {
  const project = config({ steps: [{ plugin: 'custom', after: 'prepare' }] });

  for (const definition of [{}, { script: 7 }, { script: './main.js', module: './main.js' }, { script: './main.js', folders: { BP: 7 } }]) {
    project.bedrockCore.plugins.custom = definition;
    assert.throws(() => planBuild(project), /Invalid plugin definition/);
  }

  project.bedrockCore.plugins.custom = { module: './custom.ts' };
  project.bedrockCore.profiles.default.steps[0].arguments = ['extra'];
  assert.throws(() => planBuild(project), /Script arguments require a script plugin/);
  project.bedrockCore.plugins.custom = { script: './main.js' };
  project.bedrockCore.profiles.default.steps[0].arguments = [7];
  assert.throws(() => planBuild(project), /Invalid plugin arguments/);
});

test('script step overrides replace folders and data without changing their definitions', () => {
  const project = config({ steps: [{ plugin: 'custom', after: 'prepare', folders: { RP: 'textures' }, dataPath: './second', persistData: true }] });

  project.bedrockCore.plugins.custom = { script: './main.js', folders: { BP: 'logic', RP: 'assets' }, dataPath: './first' };
  const snapshot = structuredClone(project);
  const step = planBuild(project)[1];

  assert.deepEqual(step.folders, { RP: 'textures' });
  assert.equal(step.dataPath, './second');
  assert.equal(step.persistData, true);
  assert.deepEqual(project, snapshot);
  project.bedrockCore.plugins.custom = { module: './native.ts' };
  assert.throws(() => planBuild(project), /Folder and data overrides require a Node script/);
  project.bedrockCore.plugins.custom = { script: './main.js' };
  delete project.bedrockCore.profiles.default.steps[0].dataPath;
  assert.throws(() => planBuild(project), /requires an explicit dataPath/);
});
