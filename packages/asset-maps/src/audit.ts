import type { AssetMapDocuments } from '@bedrock-core/builder-bundler/assets';
import type { Components, Document, Problem, Resources } from './bedrock/types.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { distribution } from './paths.ts';
import { releaseOutput } from './releases.ts';
import { readAssetMaps, composeAssetMaps } from '@bedrock-core/builder-bundler/assets';
import { nativeAssets } from './bedrock/native.ts';
import { nativeResources, readPackAssets } from './sources/pack.ts';

type ReadonlyComponents = { readonly 'minecraft:geometry'?: string | { readonly identifier: string }; readonly 'minecraft:material_instances'?: Readonly<Record<string, string | { readonly texture?: string }>> };
const hasComponent = (value: object | undefined, key: string): boolean => value !== undefined && Object.entries(value).some(([name, component]) => name === key && component !== undefined);

async function readNativeInputs(file: string): Promise<Record<string, Document>> {
  const value: { files: Record<string, Document> } = JSON.parse(await readFile(file, 'utf8'));

  return value.files;
}

interface AuditMaps { index: { minecraft: string }; lock: object; documents: Map<string, object> }

export interface AuditReport {
  schemaVersion: number; minecraft: string; sourceMinecraft: string; targetCompatible: boolean;
  counts: Record<string, number>; errors: Problem[]; gaps: Problem[]; redundant: string[];
  texturePixels: 'not-checked'; clientRendering: 'not-checked';
}

const geometryId = (value: ReadonlyComponents['minecraft:geometry']): string | undefined => typeof value === 'string' ? value : value?.identifier;

/** Check graph closure and classify unknown content without claiming client visual parity. */
export function auditDocuments(maps: AuditMaps, upstream: Resources, { target = maps.index.minecraft } = {}): AuditReport {
  const native = nativeAssets(upstream, { target });
  const input: AssetMapDocuments = { ...maps, index: { schemaVersion: 1, files: {}, ...maps.index }, inputs: [] };
  const catalog = composeAssetMaps(input, upstream, target);
  const documents: Resources = new Map([...maps.documents].map(([file, document]) => [file, { ...document }]));
  const errors: Problem[] = [], gaps: Problem[] = [], redundant: string[] = [];
  const canonicalBlocks = new Set((upstream.get('metadata/mojang-blocks.json')?.data_items ?? []).map(value => value.name));
  const supplementBlocks = new Set([...documents.values()].map(value => value['minecraft:block']?.description?.identifier).filter(Boolean));
  const problem = (list: Problem[], kind: string, id: string, reason: string, file?: string): number => list.push({ kind, id, reason, ...(file ? { file } : {}) });

  const checkComponents = (id: string, components: ReadonlyComponents | undefined, list: Problem[], file?: string): void => {
    const geometry = geometryId(components?.['minecraft:geometry']);

    if (geometry && !catalog.models[geometry]) {
      problem(list, 'model', id, 'Missing geometry: ' + geometry, file);
    }

    for (const binding of Object.values(components?.['minecraft:material_instances'] ?? {})) {
      if (typeof binding !== 'string' && typeof binding?.texture === 'string' && !catalog.textures[binding.texture]) {
        problem(list, 'texture', id, 'Missing terrain alias: ' + binding.texture, file);
      }
    }
  };

  for (const [file, document] of documents) {
    if (!file.startsWith('resource_pack/textures/') && !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(document.format_version ?? '')) {
      problem(errors, 'schema', file, 'A Bedrock format_version is required', file);
      continue;
    }

    const block = document['minecraft:block'], item = document['minecraft:item'];

    if (file.startsWith('behavior_pack/blocks/')) {
      const id = block?.description?.identifier;

      if (typeof id !== 'string' || !id.includes(':')) {
        problem(errors, 'schema', file, 'A namespaced block identifier is required', file);
        continue;
      }

      const existing = native.blocks[id]?.['minecraft:block'];
      const covered = (components?: Components, condition?: string | number): boolean => Object.keys(components ?? {}).every(key => hasComponent(existing?.components, key)
        || existing?.permutations?.some(value => JSON.stringify(value.condition) === JSON.stringify(condition) && hasComponent(value.components, key)));

      if (existing && covered(block!.components) && (block!.permutations ?? []).every(value => covered(value.components, value.condition))) {
        redundant.push(file);
      }

      checkComponents(id, block!.components, errors, file);

      for (const permutation of block!.permutations ?? []) {
        if (typeof permutation.condition !== 'string' && typeof permutation.condition !== 'number') {
          problem(errors, 'schema', id, 'A native permutation condition is required', file);
        }

        checkComponents(id, permutation.components, errors, file);
      }
    } else if (file.startsWith('behavior_pack/items/')) {
      const id = item?.description?.identifier;

      if (typeof id !== 'string' || !id.includes(':')) {
        problem(errors, 'schema', file, 'A namespaced item identifier is required', file);
        continue;
      }

      const existing = native.items[id];

      if (existing && Object.keys(item!.components ?? {}).every(key => hasComponent(existing['minecraft:item'].components, key) || (key === 'minecraft:icon' && existing.textures))) {
        redundant.push(file);
      }

      for (const alias of Object.values(item!.components?.['minecraft:icon']?.textures ?? {})) {
        if (!catalog.textures['item:' + alias]) {
          problem(errors, 'texture', id, 'Missing item alias: ' + alias, file);
        }
      }
    } else if (file.startsWith('resource_pack/models/')) {
      if (!Array.isArray(document['minecraft:geometry'])) {
        problem(errors, 'schema', file, 'A native geometry array is required', file);
      }

      for (const geometry of document['minecraft:geometry'] ?? []) {
        if (typeof geometry.description?.identifier !== 'string' || !Array.isArray(geometry.bones)) {
          problem(errors, 'schema', file, 'Geometry requires an identifier and bones', file);
        }

        for (const bone of geometry.bones ?? []) {
          for (const cube of bone.cubes ?? []) {
            if (cube.origin?.length !== 3 || cube.size?.length !== 3 || [...cube.origin, ...cube.size, ...cube.rotation ?? [], ...cube.pivot ?? []].some(value => !Number.isFinite(value)) || cube.size.some(value => value < 0)) {
              problem(errors, 'schema', file, 'Invalid cube dimensions or transform', file);
            }
          }
        }
      }
    }
  }

  for (const [id, block] of Object.entries(catalog.blocks)) {
    if (canonicalBlocks.size && !canonicalBlocks.has(id) && !supplementBlocks.has(id)) {
      continue;
    }

    const definition = block['minecraft:block'];

    if (!definition.components?.['minecraft:geometry'] && !definition.permutations?.some(value => value.components?.['minecraft:geometry'])) {
      problem(gaps, 'block', id, 'No render geometry is declared');
    }

    checkComponents(id, definition.components, gaps);

    for (const permutation of definition.permutations ?? []) {
      checkComponents(id, permutation.components, gaps);
    }
  }

  for (const [id, entity] of Object.entries(catalog.entities)) {
    for (const geometry of Object.values(entity['minecraft:client_entity'].description.geometry ?? {})) {
      if (typeof geometry === 'string' && !catalog.models[geometry]) {
        problem(gaps, 'entity', id, 'Missing geometry: ' + geometry);
      }
    }
  }

  for (const [id, item] of Object.entries(catalog.items ?? {})) {
    const block = item.block ? catalog.blocks[item.block.id] : undefined;

    if (!Object.keys(item.textures ?? {}).length && !block?.textures && !block?.carried_textures && !block?.['minecraft:block']?.components?.['minecraft:material_instances']) {
      problem(gaps, 'item', id, 'No icon or placed-block texture binding is declared');
    }
  }

  return { schemaVersion: 1, minecraft: target, sourceMinecraft: maps.index.minecraft, targetCompatible: target === maps.index.minecraft,
    counts: Object.fromEntries((['blocks', 'items', 'entities', 'models', 'textures'] as const).map(key => [key, Object.keys(catalog[key] ?? {}).length])),
    errors, gaps, redundant, texturePixels: 'not-checked', clientRendering: 'not-checked' };
}

export async function audit({ version, index = resolve(version ? releaseOutput(version) : distribution, 'index.json'), nativeInputs, nativePack, target, offline = false }: { version?: string; index?: string; nativeInputs?: string; nativePack?: string; target?: string; offline?: boolean } = {}): Promise<AuditReport> {
  const maps = await readAssetMaps(index);
  const upstream = nativePack ? await readPackAssets(nativePack) : nativeInputs ? new Map(Object.entries(await readNativeInputs(nativeInputs))) : await nativeResources({ version, offline });

  return auditDocuments(maps, upstream, { target });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'index': { type: 'string' },
      'version': { type: 'string' },
      'native-inputs': { type: 'string' },
      'native-pack': { type: 'string' },
      'target': { type: 'string' },
      'output': { type: 'string' },
      'offline': { type: 'boolean' },
    },
  });
  const result = await audit({
    version: values.version,
    index: values.index,
    nativeInputs: values['native-inputs'],
    nativePack: values['native-pack'],
    target: values.target,
    offline: values.offline,
  });

  if (values.output) {
    await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  }

  console.info(JSON.stringify({
    minecraft: result.minecraft,
    counts: result.counts,
    errors: result.errors.length,
    gaps: result.gaps.length,
    redundant: result.redundant.length,
  }));

  if (result.errors.length || result.redundant.length) {
    process.exitCode = 1;
  }
}
