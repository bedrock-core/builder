import type { Catalog } from '../bedrock/types.ts';
import type { DefaultStates } from '../compiler/inverse.ts';
import type { NativeImage } from '../compiler/textures.ts';
import type { GeyserMapping } from '../compiler/types.ts';
import type { ImagePixels } from './formats.ts';
import type { TextureNames } from './types.ts';
import type { JavaResources } from './types.ts';
import { resolveJavaModel, selectApplications } from '../compiler/compiler.ts';
import { pixelHash, textureNameKey, inferredTextureCandidates } from '../compiler/textures.ts';

const sides = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
const clean = (value: string): string => value.replace(/^minecraft:/, '').replace(/^textures\//, '').replace(/\.(?:png|tga)$/, '');

const defaultProperties = (block: DefaultStates['blocks'][string]): Record<string, string> => {
  const result: Record<string, string> = {}, axes = Object.entries(block.properties ?? {});
  let index = block.default;

  for (let i = axes.length - 1; i >= 0; i--) {
    result[axes[i][0]] = axes[i][1][index % axes[i][1].length];
    index = Math.floor(index / axes[i][1].length);
  }

  return result;
};

/** Derive edition texture names from native block faces, exact pixels and unambiguous names. */
export function buildTextureNames({ resources, defaults, mappings, native, images, rules = { aliases: {} } }: { resources: JavaResources; defaults: DefaultStates; mappings: Record<string, GeyserMapping>; native: Catalog; images: Map<string, NativeImage>; rules?: { aliases: Record<string, string> } }): TextureNames {
  const names = new Map<string, string[]>(), hashes = new Map<string, string[]>(), votes = new Map<string, Map<string, number>>(), targets = new Map<string, string>();

  for (const [path, image] of images) {
    const name = textureNameKey(path), hash = pixelHash(image, image.frame);

    names.set(name, [...names.get(name) ?? [], path]);
    hashes.set(hash, [...hashes.get(hash) ?? [], path]);
  }

  for (const [state, mapping] of Object.entries(mappings)) {
    const id = state.split('[')[0], properties = defaultProperties(defaults.blocks[id] ?? defaults.blocks['minecraft:' + id] ?? { default: 0 });
    const values = Object.fromEntries((state.match(/\[(.*)\]/)?.[1] ?? '').split(',').filter(Boolean).map(pair => pair.split('=')));

    if (Object.entries(properties).every(([key, value]) => values[key] === value)) {
      targets.set(id.replace(/^minecraft:/, ''), 'minecraft:' + (mapping.bedrock_identifier ?? id).replace(/^minecraft:/, ''));
    }
  }

  const vote = (source: string, path: string | undefined): void => {
    if (!path || !images.has(path)) {
      return;
    }

    source = clean(source);

    if (!votes.has(source)) {
      votes.set(source, new Map());
    }

    const values = votes.get(source)!;

    values.set(path, (values.get(path) ?? 0) + 1);
  };

  for (const [name, definition] of Object.entries(resources.blockstates)) {
    const block = defaults.blocks['minecraft:' + name], target = native.blocks[targets.get(name) ?? ''], texture = target?.textures;

    if (!block || !texture) {
      continue;
    }

    if (typeof texture !== 'string' && new Set(sides.slice(0, 4).map(side => texture[side] ?? texture.side ?? texture['*'])).size > 1) {
      continue;
    }

    const applications = selectApplications(definition, defaultProperties(block));

    if (applications.length !== 1 || applications[0].length !== 1) {
      continue;
    }

    const application = applications[0][0];

    if (application.x || application.y) {
      continue;
    }

    const model = resolveJavaModel(application.model, resources.models);

    if (model.elements?.length !== 1 || model.elements[0].from?.some(value => value !== 0) || model.elements[0].to?.some(value => value !== 16) || model.elements[0].rotation) {
      continue;
    }

    for (const side of sides) {
      let source: string | { sprite: string } | undefined = model.elements[0].faces?.[side]?.texture;
      const seen = new Set();

      while (typeof source === 'string' && source.startsWith('#')) {
        if (seen.has(source)) {
          throw new Error('Cyclic Java texture name');
        }

        seen.add(source);
        source = model.textures?.[source.slice(1)];
      }

      if (source && typeof source === 'object') {
        source = source.sprite;
      }

      if (typeof source !== 'string') {
        continue;
      }

      const alias = typeof texture === 'string' ? texture : texture[side] ?? texture.side ?? texture['*'];
      const paths = native.textures[alias ?? '']?.paths ?? [];

      if (paths.length === 1) {
        vote(source, paths[0]);
      }
    }
  }

  const mappingsByName = { ...rules.aliases };

  for (const [source, path] of Object.entries(rules.aliases)) {
    if (!/^(?:block|item|entity)\//.test(source) || typeof path !== 'string' || !images.has(path) || (!source.startsWith('item/') && path.startsWith('textures/items/'))) {
      throw new Error('Invalid native texture alias rule: ' + source);
    }
  }

  const imageOf = (path: string): ImagePixels | undefined => resources.sprites.get(path) ?? resources.image(path);

  const resolve = (value: string, dimensions?: readonly [number, number]): string | undefined => {
    const source = clean(value), image = imageOf(source);

    const compatible = (path: string): boolean | undefined => {
      if (typeof path !== 'string') {
        return false;
      }

      if (!source.startsWith('item/') && path.startsWith('textures/items/')) {
        return false;
      }

      const target = images.get(path), size = dimensions ?? (image ? [image.width, image.height] : undefined);

      return target && size && target.frame[2] / target.frame[3] === size[0] / (size[1] > size[0] && size[1] % size[0] === 0 && target.frame[3] < target.height ? size[0] : size[1]);
    };

    if (compatible(rules.aliases[source])) {
      return rules.aliases[source];
    }

    const group = source.split('/')[0], direct = 'textures/' + source.replace(/^[^/]+\//, ({ block: 'blocks/', item: 'items/' } as Record<string, string>)[group] ?? group + '/');

    if (image) {
      const frame: [number, number, number, number] = [0, 0, image.width, image.height > image.width && image.height % image.width === 0 ? image.width : image.height];
      const identical = (hashes.get(pixelHash(image, frame)) ?? []).filter(compatible).sort();

      if (identical.length) {
        return identical.find(path => path === direct) ?? identical.find(path => (names.get(textureNameKey(source)) ?? []).includes(path)) ?? identical[0];
      }
    }

    if (compatible(direct)) {
      return direct;
    }

    const agreed = [...votes.get(source) ?? []].filter(([path]) => compatible(path)).sort(([a, left], [b, right]) => right - left || a.localeCompare(b));

    if (agreed.length && (agreed.length === 1 || agreed[0][1] > agreed[1][1])) {
      return agreed[0][0];
    }

    const named = (names.get(textureNameKey(source)) ?? []).filter(compatible);

    if (named.length === 1) {
      return named[0];
    }

    return undefined;
  };

  for (const source of resources.sprites.keys()) {
    if (rules.aliases[source]) {
      mappingsByName[source] = rules.aliases[source];
      continue;
    }

    const path = resolve(source);

    if (path) {
      mappingsByName[source] = path;
    } else {
      const named = (names.get(textureNameKey(source)) ?? []).filter(path => !path.startsWith('textures/items/'));

      if (named.length === 1) {
        mappingsByName[source] = named[0];
      }
    }
  }

  const inferred = inferredTextureCandidates(mappingsByName, images.keys());

  for (const source of resources.sprites.keys()) {
    if (mappingsByName[source]) {
      continue;
    }

    const candidates = inferred(source).filter(path => !path.startsWith('textures/items/'));

    if (candidates.length === 1) {
      mappingsByName[source] = candidates[0];
    }
  }

  return { mappings: Object.fromEntries(Object.entries(mappingsByName).sort(([a], [b]) => a.localeCompare(b))), resolve };
}
