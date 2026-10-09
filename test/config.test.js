import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.ts';
import { planBuild } from '../src/plan.ts';

const example = () =>
  JSON.parse(readFileSync(new URL('../examples/script-only/config.json', import.meta.url), 'utf8'));

test('example validates without mutation and preserves other tools', () => {
  const config = example();

  config.bridge = { custom: true };
  config.regolith = { profiles: {} };
  const snapshot = structuredClone(config);

  assert.equal(validateConfig(config), config);
  assert.deepEqual(config, snapshot);
});

test('Bedrock configs need no type discriminator and key order does not affect validation', () => {
  const config = Object.fromEntries(Object.entries(example()).reverse());
  const snapshot = structuredClone(config);

  assert.equal(Object.hasOwn(config, 'type'), false);
  assert.equal(Object.hasOwn(config, 'worlds'), false);
  assert.equal(validateConfig(config), config);
  assert.deepEqual(config, snapshot);
  assert.deepEqual(Object.keys(config), Object.keys(snapshot));
});
test('authors is required and unrelated top-level metadata is preserved', () => {
  const config = example();

  delete config.authors;
  config.author = 'Author';
  assert.throws(() => validateConfig(config), /Invalid project configuration/);
  config.authors = [{ name: 'Author', logo: './icon.png' }];
  validateConfig(config);
  delete config.author;
  validateConfig(config);
  delete config.authors;
  assert.throws(() => validateConfig(config), /Invalid project configuration/);
});
test('unknown builder fields, malformed metadata and unsupported versions fail', () => {
  for (const change of [
    (c) => {
      c.bedrockCore.dataPath = './data';
    },
    (c) => {
      c.bedrockCore.profiles.default.stages.bundelr = true;
    },
    (c) => {
      c.bedrockCore.profiles.default.export.behaviorPack = { path: './dist' };
    },
    (c) => {
      c.bedrockCore.formatVersion = '2.0.0';
    },
    (c) => {
      c.namespace = 'minecraft';
    },
    (c) => {
      c.packs.behaviorPack = '  ';
    },
    (c) => {
      c.authors = 'Author';
    },
    (c) => {
      c.targetVersion = 12;
    },
  ]) {
    const config = example();

    change(config);
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});
test('UI settings use the nested schema for screen modules, metadata and formatting', () => {
  const config = example();

  config.bedrockCore.profiles.default.stages['ui-compiler'] = {
    namespace: 'screens', screens: ['./screens.tsx', '@bedrock-core/catalog/compiled'],
    testMetadata: true, stamp: true, tsconfig: './tsconfig.json', pretty: { indent: 'space', size: 2 },
  };
  validateConfig(config);

  for (const settings of [
    { namespace: 'Bad Namespace' },
    { screens: [42] },
    { testMetadata: 'true' },
    { pretty: { size: 0 } },
    { pretty: { tabs: true } },
    { entry: './screens.tsx' },
  ]) {
    config.bedrockCore.profiles.default.stages['ui-compiler'] = settings;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});

test('hooks require exactly one supported boundary and object settings', () => {
  for (const step of [
    { plugin: 'custom' },
    { plugin: 'custom', before: 'bundler', after: 'bundler' },
    { plugin: 'custom', after: 'export' },
    { plugin: 'custom', before: 'prepare' },
    { plugin: 'custom', before: 'bundler', settings: [] },
  ]) {
    const config = example();

    config.bedrockCore.profiles.default.steps = [step];
    assert.throws(() => validateConfig(config));
  }
});
test('valid extensions reach planner checks for missing plugin and disabled stage', () => {
  const config = example();

  config.bedrockCore.plugins = { custom: { module: './custom.ts' } };
  config.bedrockCore.profiles.default.steps = [
    { plugin: 'custom', before: 'bundler', settings: { arbitrary: [1, 2] } },
  ];
  planBuild(validateConfig(config));
  config.bedrockCore.profiles.default.stages.bundler = false;
  assert.throws(() => planBuild(validateConfig(config)), /Unavailable boundary/);
  config.bedrockCore.profiles.default.stages.bundler = true;
  delete config.bedrockCore.plugins.custom;
  assert.throws(() => planBuild(validateConfig(config)), /Missing plugin/);
});

test('named Node scripts and native modules validate without changing settings', () => {
  const config = example();

  config.bedrockCore.plugins = {
    generate: { script: './filters/main.cjs', filterDir: '.', dataPath: './data', packs: { RP: 'visuals' }, nodeArguments: ['--no-warnings'] },
    finish: { module: './finish.ts', targets: 'resource' },
  };
  config.bedrockCore.profiles.default.steps = [
    { plugin: 'generate', after: 'prepare', settings: { name: 'Example' }, arguments: ['extra'] },
    { plugin: 'finish', before: 'export' },
  ];
  const snapshot = structuredClone(config);

  planBuild(validateConfig(config));
  assert.deepEqual(config, snapshot);

  for (const definition of [
    {}, { script: '' }, { script: './main.js', module: './main.js' },
    { script: './main.js', settings: {} }, { script: './main.js', arguments: ['extra'] },
    { script: './main.js', filterDir: 7 }, { script: './main.js', nodeArguments: [true] },
    { script: './main.js', packs: {} }, { script: './main.js', packs: { RP: 7 } },
    { script: './main.js', targets: 'textures' }, { script: './main.js', targets: ['resource'] },
    { script: './main.js', targets: 'resource', packs: { RP: 'visuals' } },
  ]) {
    config.bedrockCore.plugins.generate = definition;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});

test('pack targets validate for scripts and modules', () => {
  for (const targets of ['resource', 'behavior', 'both']) {
    for (const entry of [{ script: './filter.cjs' }, { module: './plugin.ts' }]) {
      const config = example();

      config.bedrockCore.plugins = { generate: { ...entry, targets } };
      config.bedrockCore.profiles.default.steps = [{ plugin: 'generate', after: 'prepare' }];
      assert.equal(planBuild(validateConfig(config)).find(step => step.plugin === 'generate').targets, targets);
    }
  }
});
