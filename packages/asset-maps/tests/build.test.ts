import type { SourceLock, Sources } from '../src/sources/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { composeAssetMaps, generateVanillaAssets, readAssetMaps } from '@bedrock-core/builder-bundler/assets';
import { nativeResources } from '../src/sources/pack.ts';

const indexFile = fileURLToPath(new URL('../dist/index.json', import.meta.url));
const cacheRoot = fileURLToPath(new URL('../.bedrock-core/cache/asset-maps/inputs', import.meta.url));

test('builds the runtime catalog from final JSON and the pinned native archive without compiled tables', async () => {
  const tracked: string[] = [];
  const result = await generateVanillaAssets({ mapsIndex: indexFile, targetVersion: '1.26.60', cacheRoot, offline: true, registerDependency: file => tracked.push(file) });

  assert.ok(result.catalog);
  assert.equal(result.catalog.minecraft, '1.26.60.30');
  assert.ok(result.catalog.blocks['minecraft:stone']);
  assert.ok(result.catalog.entities['minecraft:pig']);
  assert.ok(result.catalog.models['geometry.allay']);
  assert.ok(Object.keys(result.catalog.models).some(id => id.startsWith('geometry.bedrock_core.asset_maps.')));
  assert.deepEqual(result.files, []);
  assert.ok(tracked.some(file => file.endsWith('.zip')));
  assert.ok(tracked.every(file => !/java-inputs|java-models|java-inverse|texture-bindings|renderer-inputs|native-inputs|compiled-integrity/.test(file)));
  const expected = composeAssetMaps(await readAssetMaps(indexFile), await nativeResources({ offline: true }));

  assert.deepEqual(result.catalog, expected);
});

test('rejects incompatible targets before loading native source data', async () => {
  for (const targetVersion of ['1.26.50', '1.27.0', undefined]) {
    const result = await generateVanillaAssets({ mapsIndex: indexFile, targetVersion, nativePacks: ['does-not-exist'] });

    assert.equal(result.catalog, undefined);
    assert.ok(result.unavailable);
    assert.match(result.unavailable, /1\.26\.60\.30/);
    assert.deepEqual(result.files, []);
  }
});

test('final provenance records upstream pins and has no references to generated middle files', async () => {
  const maps = await readAssetMaps(indexFile);
  const pins: Sources = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url), 'utf8'));
  const lock = maps.lock as SourceLock;

  assert.deepEqual(lock.upstream.archive, pins.bedrock.archive);
  assert.deepEqual(lock.conversion.client, pins.java.client);
  assert.equal(lock.conversion.mappings, pins.mappings.version);
  assert.match(lock.conversion.revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(maps.lock), /java-inputs|java-models|java-inverse|texture-bindings|renderer-inputs|native-inputs|compiled-integrity/);
});
