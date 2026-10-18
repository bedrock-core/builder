#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiRoot = resolve(root, process.argv[2] ?? '../ui');
const template = resolve(root, 'packages/cli/templates/bedrock-core');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
const uiVersion = read(resolve(uiRoot, 'package.json')).version;
const builderVersion = read(resolve(root, 'package.json')).version;
const render = read(resolve(uiRoot, 'packages/resource-pack/packs/RP/manifest.json'));

if (typeof render.header?.uuid !== 'string' || typeof render.header?.version !== 'string') {
  throw new Error('The UI checkout must contain a versioned render-pack manifest');
}

const packageFile = resolve(template, 'package.json');
const pkg = read(packageFile);

pkg.dependencies['@bedrock-core/ui'] = uiVersion;
pkg.dependencies['@bedrock-core/navigation'] = read(resolve(uiRoot, 'packages/navigation/package.json')).version;
pkg.devDependencies['@bedrock-core/builder'] = builderVersion;
save(packageFile, pkg);

for (const file of ['manifest.json', 'manifest.test.json']) {
  const manifestFile = resolve(template, 'packs/BP', file);
  const manifest = read(manifestFile);
  const dependency = manifest.dependencies?.find(entry => entry.uuid === render.header.uuid);

  if (!dependency) {
    throw new Error(`${file} must declare render pack ${render.header.uuid}`);
  }

  dependency.version = render.header.version;
  save(manifestFile, manifest);
}

console.log(`@bedrock-core: CLI template pins builder ${builderVersion}, UI ${uiVersion} and render pack ${render.header.version}`);
