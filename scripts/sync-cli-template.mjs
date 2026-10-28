#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const repository = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');

/** Update the starter's Builder pin using this repository alone. */
export function syncBuilderTemplate(root = repository) {
  const file = resolve(root, 'packages/cli/templates/bedrock-core/package.json');
  const pkg = read(file);
  const builderVersion = read(resolve(root, 'package.json')).version.split('-')[0];

  pkg.devDependencies['@bedrock-core/builder'] = builderVersion;
  save(file, pkg);

  return { builderVersion };
}

/** Align starter dependencies with the versioned owning checkouts. */
export function syncCliTemplate(root = repository, uiRoot = resolve(root, '../ui')) {
  const template = resolve(root, 'packages/cli/templates/bedrock-core');
  const uiVersion = read(resolve(uiRoot, 'package.json')).version;
  const builderVersion = read(resolve(root, 'package.json')).version.split('-')[0];
  const render = read(resolve(uiRoot, 'packages/resource-pack/packs/RP/manifest.json'));
  const navigationVersion = read(resolve(uiRoot, 'packages/navigation/package.json')).version;
  const packageFile = resolve(template, 'package.json');
  const pkg = read(packageFile);
  const versions = {
    '@bedrock-core/catalog': read(resolve(root, '../apps/packages/catalog/package.json')).version,
    '@bedrock-core/config': read(resolve(root, '../apps/packages/config/package.json')).version,
    '@bedrock-core/guides': read(resolve(root, '../apps/packages/guides/package.json')).version,
    '@bedrock-core/i18n': read(resolve(root, '../server/packages/i18n/package.json')).version,
    '@bedrock-core/server': read(resolve(root, '../server/package.json')).version,
  };

  if (typeof render.header?.uuid !== 'string' || typeof render.header?.version !== 'string') {
    throw new Error('The UI checkout must contain a versioned render-pack manifest');
  }

  for (const [name, version] of Object.entries(versions)) {
    pkg.dependencies[name] = '^' + version;
  }

  pkg.dependencies['@bedrock-core/ui'] = uiVersion;
  pkg.dependencies['@bedrock-core/navigation'] = navigationVersion;
  pkg.devDependencies['@bedrock-core/builder'] = builderVersion;
  pkg.devDependencies['@bedrock-core/bds-runner'] = '^' + read(resolve(root, '../bds-runner/package.json')).version;
  const manifests = ['manifest.json', 'manifest.test.json'].map((name) => {
    const file = resolve(template, 'packs/BP', name);
    const manifest = read(file);
    const dependency = manifest.dependencies?.find(entry => entry.uuid === render.header.uuid);

    if (!dependency) {
      throw new Error(name + ' must declare render pack ' + render.header.uuid);
    }

    dependency.version = render.header.version;
    delete dependency.description;

    return { file, manifest };
  });

  save(packageFile, pkg);

  for (const { file, manifest } of manifests) {
    save(file, manifest);
  }

  return { builderVersion, uiVersion, navigationVersion, renderVersion: render.header.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv[2] === '--builder-only'
    ? syncBuilderTemplate()
    : syncCliTemplate(repository, resolve(repository, process.argv[2] ?? '../ui'));

  console.info('@bedrock-core: CLI template pins ' + JSON.stringify(result));
}
