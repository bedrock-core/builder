import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAssets } from './native.mjs';
import { parsePackJson, readNativePacks } from './pack.mjs';
import { assetFile, upstreamResources } from './source.mjs';
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value) ? value.split('.').slice(0, 3).join('.') : undefined;
const hash = value => createHash('sha256').update(value).digest('hex');

export function assetMapsIndex(projectRoot = process.cwd()) {
  try {
    return createRequire(path.join(projectRoot, 'package.json')).resolve('@bedrock-core/asset-maps');
  } catch (cause) {
    throw new Error('bundler.vanillaAssets=true requires @bedrock-core/asset-maps as a project build dependency.', { cause });
  }
}

export async function readAssetMaps(indexFile) {
  const root = path.dirname(indexFile), index = parsePackJson(await readFile(indexFile, 'utf8'));
  const lockFile = path.join(root, 'source-lock.json'), lock = parsePackJson(await readFile(lockFile, 'utf8'));

  if (index.schemaVersion !== 1 || lock.schemaVersion !== 1 || index.minecraft !== lock.minecraft || !index.files || !version(index.minecraft)) {
    throw new Error('Invalid asset-map index or source lock');
  }

  const documents = new Map(), inputs = [indexFile, lockFile];

  for (const [name, expected] of Object.entries(index.files)) {
    const file = assetFile(root, name), bytes = await readFile(file);

    if (!/^[a-f0-9]{64}$/.test(expected) || hash(bytes) !== expected) {
      throw new Error('Asset-map document hash mismatch: ' + name);
    }

    inputs.push(file);
    documents.set(name, parsePackJson(bytes.toString('utf8')));
  }

  return { index, lock, documents, inputs };
}

function supplement(resources, name, document) {
  const kind = name.startsWith('behavior_pack/blocks/') ? 'minecraft:block' : name.startsWith('behavior_pack/items/') ? 'minecraft:item' : undefined;

  if (kind) {
    const incoming = document[kind], id = incoming?.description?.identifier;

    if (typeof id !== 'string') {
      throw new Error('Asset-map definition requires an identifier: ' + name);
    }

    const found = [...resources].find(([, source]) => source?.[kind]?.description?.identifier === id);

    if (found) {
      const original = found[1], native = original[kind];
      const permutations = (incoming.permutations ?? []).map(value => ({ ...value, components: Object.fromEntries(Object.entries(value.components ?? {}).filter(([key]) => native.components?.[key] === undefined)) })).filter(value => Object.keys(value.components).length);

      resources.set(found[0], { ...document, ...original, [kind]: { ...incoming, ...native, description: { ...incoming.description, ...native.description },
        components: { ...incoming.components, ...native.components }, ...(incoming.permutations || native.permutations ? { permutations: [...permutations, ...native.permutations ?? []] } : {}) } });

      return;
    }
  }

  const member = name.replace(/^(?:behavior_pack|resource_pack)\//, '');

  if (/^textures\/(?:terrain|item)_texture\.json$/.test(member)) {
    const native = resources.get(member);

    resources.set(member, { ...document, ...native, texture_data: { ...document.texture_data, ...native?.texture_data } });
  } else {
    resources.set(member, document);
  }
}

export function composeAssetMaps(maps, upstream, target = maps.index.minecraft) {
  const resources = new Map(upstream);

  for (const [name, document] of maps.documents) {
    supplement(resources, name, document);
  }

  const catalog = { schemaVersion: 2, id: `minecraft:vanilla/${version(target)}`, revision: 0, minecraft: target,
    ...nativeAssets(resources, { target }), provenance: { kind: 'asset-maps', sourceLock: maps.lock } };

  catalog.revision = Number.parseInt(hash(JSON.stringify(catalog)).slice(0, 12), 16);

  return catalog;
}

/** Compose immutable Mojang input and JSON supplements into the runtime's typed asset view. */
export async function generateVanillaAssets(options = {}) {
  const { targetVersion, registerDependency = () => { }, dependencyRoot = process.cwd(), nativePacks } = options;
  const indexFile = path.resolve(options.mapsIndex ?? assetMapsIndex(dependencyRoot)), root = path.dirname(indexFile), inputs = new Set([indexFile]);
  const index = parsePackJson(await readFile(indexFile, 'utf8'));

  const track = (file) => {
    inputs.add(file);
    registerDependency(file);
  };

  track(indexFile);

  for (const name of ['catalog.mjs', 'native.mjs', 'pack.mjs', 'source.mjs']) {
    track(fileURLToPath(new URL('./' + name, import.meta.url)));
  }

  if (index.schemaVersion !== 1 || !index.files || !version(index.minecraft)) {
    throw new Error('Invalid asset-map index');
  }

  if (!version(targetVersion) || version(targetVersion) !== version(index.minecraft)) {
    return { inputs: [...inputs], files: [], unavailable: `checked asset maps cover ${index.minecraft}; requested ${String(targetVersion)}` };
  }

  const lockFile = path.join(root, 'source-lock.json'), lock = parsePackJson(await readFile(lockFile, 'utf8'));

  track(lockFile);

  if (lock.schemaVersion !== 1 || lock.minecraft !== index.minecraft) {
    throw new Error('Asset-map index and source lock do not match');
  }

  let resources;
  const supplied = nativePacks ?? (process.env.MINECRAFT_VANILLA_PACKS ? [process.env.MINECRAFT_VANILLA_PACKS] : undefined);

  if (supplied?.length) {
    resources = new Map();

    for (const directory of Array.isArray(supplied) ? supplied : [supplied]) {
      for (const [name, document] of await readNativePacks(directory, index.minecraft, track)) {
        resources.set(name, document);
      }
    }
  } else {
    resources = await upstreamResources(lock, { ...options, dependencyRoot, registerDependency: track });
  }

  const maps = await readAssetMaps(indexFile);

  for (const input of maps.inputs) {
    track(input);
  }

  const catalog = composeAssetMaps(maps, resources);

  return { catalog, inputs: [...inputs], files: [] };
}
