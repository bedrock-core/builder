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
      c.type = 'minecraftJava';
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
