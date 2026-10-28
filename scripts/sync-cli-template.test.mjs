import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { syncBuilderTemplate, syncCliTemplate } from './sync-cli-template.mjs';

test('template synchronization follows each owning package and keeps Navigation independent', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cli-version-sync-'));

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'builder');
  const template = 'builder/packages/cli/templates/bedrock-core';

  const put = (file, data) => {
    const target = path.join(directory, file);

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(data));
  };

  for (const [file, version] of [
    ['builder/package.json', '0.1.0'],
    ['ui/package.json', '0.13.0'],
    ['ui/packages/navigation/package.json', '0.14.0'],
    ['apps/packages/catalog/package.json', '0.2.0'],
    ['apps/packages/config/package.json', '0.4.0'],
    ['apps/packages/guides/package.json', '0.3.0'],
    ['server/packages/i18n/package.json', '0.2.0'],
    ['server/package.json', '0.2.1'],
    ['bds-runner/package.json', '0.2.0'],
  ]) { put(file, { version }); }

  put('ui/packages/resource-pack/packs/RP/manifest.json', { header: { uuid: 'shared-ui', version: '1.13.0' } });
  put(template + '/package.json', { dependencies: {}, devDependencies: {} });

  for (const name of ['manifest.json', 'manifest.test.json']) {
    put(template + '/packs/BP/' + name, { dependencies: [{ uuid: 'shared-ui', version: '1.12.1' }] });
  }

  syncCliTemplate(root);
  const pkg = JSON.parse(readFileSync(path.join(directory, template, 'package.json'), 'utf8'));

  assert.equal(pkg.dependencies['@bedrock-core/navigation'], '0.14.0');
  assert.equal(pkg.dependencies['@bedrock-core/ui'], '0.13.0');
  assert.equal(pkg.dependencies['@bedrock-core/catalog'], '^0.2.0');
  assert.equal(pkg.dependencies['@bedrock-core/config'], '^0.4.0');
  assert.equal(pkg.dependencies['@bedrock-core/guides'], '^0.3.0');
  assert.equal(pkg.dependencies['@bedrock-core/server'], '^0.2.1');
  assert.equal(pkg.devDependencies['@bedrock-core/bds-runner'], '^0.2.0');

  for (const name of ['manifest.json', 'manifest.test.json']) {
    const manifest = JSON.parse(readFileSync(path.join(directory, template, 'packs/BP', name), 'utf8'));

    assert.equal(manifest.dependencies[0].version, '1.13.0');
  }
});

test('Builder release versioning updates the starter without sibling repositories', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-builder-version-'));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, 'packages/cli/templates/bedrock-core/package.json');

  mkdirSync(path.dirname(template), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.2' }));
  const original = {
    dependencies: { '@bedrock-core/ui': '0.14.0', '@bedrock-core/navigation': '0.13.1' },
    devDependencies: { '@bedrock-core/builder': '0.1.1', 'typescript': '5.9.3' },
  };

  writeFileSync(template, JSON.stringify(original));

  assert.deepEqual(syncBuilderTemplate(root), { builderVersion: '0.1.2' });
  const pkg = JSON.parse(readFileSync(template, 'utf8'));

  assert.equal(pkg.devDependencies['@bedrock-core/builder'], '0.1.2');
  assert.equal(pkg.devDependencies.typescript, original.devDependencies.typescript);
  assert.deepEqual(pkg.dependencies, original.dependencies);
});
