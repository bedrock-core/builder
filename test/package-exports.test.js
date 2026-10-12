import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('built-in and external plugins resolve the same public entry points', () => {
  const entries = [
    '@bedrock-core/builder-plugin',
    '@bedrock-core/builder-manifest/plugin',
    '@bedrock-core/builder-bundler/plugin',
    '@bedrock-core/builder-bundler/compile',
    '@bedrock-core/builder-bundler/entries',
    '@bedrock-core/builder-generator/plugin',
    '@bedrock-core/builder-guides/plugin',
    '@bedrock-core/builder-i18n/plugin',
    '@bedrock-core/builder-ui/plugin',
  ];

  for (const entry of entries) {
    assert.ok(statSync(require.resolve(entry)).isFile(), `${entry} must resolve to an implementation file`);
  }
});

for (const name of ['plugin', 'manifest', 'bundler', 'generator', 'guides', 'i18n', 'ui', 'validation']) {
  test(`builder-${name} rejects unlisted implementation entry points`, () => {
    assert.throws(() => require.resolve(`@bedrock-core/builder-${name}/internal/index`), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  });
}

test('feature implementation helpers are private to their owning packages', () => {
  for (const entry of [
    '@bedrock-core/builder-bundler/internal/dependencies',
    '@bedrock-core/builder-generator/internal/category',
    '@bedrock-core/builder-generator/internal/deterministic',
    '@bedrock-core/builder-guides/internal/project',
    '@bedrock-core/builder-ui/internal',
    '@bedrock-core/builder-ui/internal/sugar',
    '@bedrock-core/builder-ui/internal/worker',
  ]) {
    assert.throws(() => require.resolve(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
