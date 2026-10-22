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

test('profile defaults and stage overrides validate, while manifests select files', () => {
  const config = example();
  const profile = config.bedrockCore.profiles.default;

  profile.pretty = { indent: 'tab', size: 1 };
  profile.debug = true;
  profile.stages.manifest = { manifestPath: ['packs/BP/manifest.test.json'], pretty: false, debug: false };
  profile.stages.bundler = { pretty: false, debug: false };
  const snapshot = structuredClone(config);

  validateConfig(config);
  assert.deepEqual(config, snapshot);

  for (const value of [[], 7, [''], [false]]) {
    profile.stages.manifest.manifestPath = value;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }

  profile.stages.manifest = { packs: { behaviorPack: { scriptEntry: 'scripts/tests.js' } } };
  assert.throws(() => validateConfig(config), /Invalid project configuration/);
  delete profile.stages.manifest;
  profile.debug = 'yes';
  assert.throws(() => validateConfig(config), /Invalid project configuration/);
  profile.debug = true;
  profile.pretty = { indent: 'invalid' };
  assert.throws(() => validateConfig(config), /Invalid project configuration/);
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
      c.bedrockCore.addon = { creator: 'author', pack: 'addon' };
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
    generate: { script: './filters/main.cjs', filterDir: '.', dataPath: './data', folders: { RP: 'visuals' }, nodeArguments: ['--no-warnings'] },
    finish: { module: './finish.ts', packs: ['visuals'] },
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
    { script: './main.js', folders: { unknown: 'visuals' } }, { script: './main.js', folders: { RP: 7 } },
    { script: './main.js', targets: 'textures' }, { script: './main.js', targets: ['resource'] },
    { script: './main.js', targets: 'resource', packs: { RP: 'visuals' } },
  ]) {
    config.bedrockCore.plugins.generate = definition;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});

test('scripts use folder mappings while native plugins use owner restrictions', () => {
  const config = example();

  config.bedrockCore.plugins = { generate: { script: './filter.cjs', folders: { RP: 'visuals' } } };
  config.bedrockCore.profiles.default.steps = [{ plugin: 'generate', after: 'prepare' }];
  assert.deepEqual(planBuild(validateConfig(config)).find(step => step.plugin === 'generate').folders, { RP: 'visuals' });
  config.bedrockCore.plugins.generate = { module: './plugin.ts', packs: ['visuals'] };
  assert.deepEqual(planBuild(validateConfig(config)).find(step => step.plugin === 'generate').packs, ['visuals']);
});
