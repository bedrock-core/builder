import type { ExtractedEntityModel } from '../compiler/entity.ts';
import type { JavaResources, JavaSource, RendererInputs, RendererProfile, Runtime } from './types.ts';
import type { buildTextureNames } from './texture-names.ts';
import { createHash } from 'node:crypto';
import { jsonBytes } from './java.ts';
import { resolveJavaModel } from '../compiler/compiler.ts';

const hash = (value: unknown): string => createHash('sha256').update(jsonBytes(value)).digest('hex');
const clean = (value: string): string => value.replace(/^minecraft:/, '').replace(/^textures\//, '').replace(/\.(?:png|tga)$/, '');

/** Attach reviewed renderer placement and material roles to geometry extracted from the same client. */
export function buildRendererInputs({ java, runtime, resources, profile, names, minecraft }: { java: JavaSource; runtime: Runtime; resources: JavaResources; profile: RendererProfile; names: ReturnType<typeof buildTextureNames>; minecraft: string }): RendererInputs {
  if (profile.schemaVersion !== 1 || profile.java !== java.version || profile.client !== java.client.sha256) {
    throw new Error('Renderer profiles must be reviewed for the pinned Java client');
  }

  const models: RendererInputs['models'] = {}, textures: RendererInputs['textures'] = {};

  const sheet = (source: string, dimensions: readonly [number, number]): void => {
    const key = clean(source) + '|' + dimensions.join(',');

    textures[key] ??= names.resolve(source, dimensions) ?? { error: 'No native entity texture sheet with matching identity and dimensions' };
  };

  for (const [id, definition] of Object.entries(profile.models)) {
    const layers: ExtractedEntityModel['layers'] = {};

    for (const [name, metadata] of Object.entries(definition.layers)) {
      const layer = runtime.models[id]?.[name];

      if (!layer) {
        throw new Error('Pinned Java renderer layer is absent: ' + id + '/' + name);
      }

      layers[name] = { ...layer, ...metadata };

      if (metadata.textureLocation) {
        sheet(metadata.textureLocation, layer.texture);
      }
    }

    models[id] = { id, transform: definition.transform, layers };
  }

  const blocks: RendererInputs['blocks'] = {};

  for (const [id, definition] of Object.entries(profile.blocks)) {
    if (!resources.blockstates[id.replace(/^minecraft:/, '')]) {
      throw new Error('Renderer profile references an unregistered Java block: ' + id);
    }

    for (const part of definition.parts) {
      const layer = models[part.model]?.layers[part.layer ?? 'main'];

      if (!layer) {
        throw new Error('Block renderer profile references an unavailable layer: ' + id);
      }

      if (part.textureLocation) {
        sheet(part.textureLocation, layer.texture);
      }
    }

    blocks[id] = definition;
  }

  const frameModels = Object.fromEntries(['item_frame', 'item_frame_map', 'glow_item_frame', 'glow_item_frame_map'].map(id => [id, resolveJavaModel(id, resources.models)]));

  for (const model of Object.values(frameModels)) {
    for (const texture of Object.values(model.textures ?? {})) {
      if (typeof texture === 'string' && !texture.startsWith('#')) {
        sheet(texture, [16, 16]);
      }
    }
  }

  const source = { schemaVersion: 1, java: java.version, revision: hash({ extraction: runtime.extractionRevision, profile }), client: java.client, profile: { file: 'renderer-profiles.json', contentSha256: hash(profile) } };

  return { schemaVersion: 1, minecraft, source, blocks, models, frameModels, textures };
}
