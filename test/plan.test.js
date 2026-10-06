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
