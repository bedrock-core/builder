import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { PackInfo } from '@bedrock-core/builder-plugin';
import type {
  BlockComponents, BlockDocument, BlockTextureBindings, ClientEntityDescription, ClientEntityDocument,
  DeepReadonly, FlipbookTexture, ItemComponents, ItemDocument, ModelGeometry, MolangExpression, TextureAtlasEntry,
} from '@bedrock-core/bedrock-types';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [name: string]: JsonValue }

export interface TextureAsset { paths: string[]; definition: string | DeepReadonly<TextureAtlasEntry>; flipbook?: DeepReadonly<FlipbookTexture> }

export interface AssetCatalogRef { id: string; revision: number }

export interface AssetReference { id: string; catalog?: AssetCatalogRef }

export interface ModelAsset {
  geometry: DeepReadonly<ModelGeometry>;
  formatVersion?: string;
  provenance?: JsonObject;
}

export interface BlockAsset {
  readonly 'format_version': BlockDocument['format_version'];
  readonly 'minecraft:block': {
    readonly description: {
      readonly identifier: BlockDocument['minecraft:block']['description']['identifier'];
      readonly states?: DeepReadonly<Record<string, (string | number | boolean)[] | { values: { min: number; max: number } }>>;
    };
    readonly components?: CollectedBlockComponents;
    readonly permutations?: readonly { readonly condition: PermutationCondition; readonly components: CollectedBlockComponents }[];
  };
  'textures'?: BlockTextureBindings;
  'carried_textures'?: BlockTextureBindings;
}

export interface EntityAsset {
  readonly 'format_version': ClientEntityDocument['format_version'];
  readonly 'minecraft:client_entity': { readonly description: DeepReadonly<ClientEntityDescription> };
}

export interface ItemAsset {
  readonly 'format_version': ItemDocument['format_version'];
  readonly 'minecraft:item': {
    readonly description: { readonly identifier: NonNullable<ItemDocument['minecraft:item']['description']>['identifier'] };
    readonly components?: CollectedItemComponents;
  };
  'textures'?: Record<string, AssetReference>;
  'block'?: AssetReference;
  'provenance'?: JsonObject;
}

export interface AssetBundle {
  schemaVersion: 2;
  revision: number;
  textures: Record<string, TextureAsset>;
  models: Record<string, ModelAsset>;
  blocks: Record<string, BlockAsset>;
  entities: Record<string, EntityAsset>;
  items?: Record<string, ItemAsset>;
  imports?: AssetCatalogRef[];
  catalogs?: SharedAssetCatalog[];
}

export interface SharedAssetCatalog extends AssetBundle { id: string; minecraft?: string; provenance?: JsonObject }

export interface CollectedAssets { bundle: AssetBundle; inputs: string[]; directories: string[] }

export function assetRevision(bundle: AssetBundle): number {
  return Number.parseInt(createHash('sha256').update(JSON.stringify({ ...bundle, revision: 0 })).digest('hex').slice(0, 12), 16);
}

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const fileKey = (file: string): string => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const texturePath = (value: string): string => value.replaceAll('\\', '/').replace(/\.(?:png|tga|jpe?g)$/i, '');
const renderKeys = ['minecraft:geometry', 'minecraft:material_instances', 'minecraft:transformation', 'minecraft:item_visual', 'minecraft:light_emission', 'minecraft:light_dampening'] as const satisfies readonly (keyof BlockComponents)[];
const itemKeys = ['minecraft:icon', 'minecraft:block_placer'] as const satisfies readonly (keyof ItemComponents)[];

type CollectedBlockComponents = DeepReadonly<Pick<BlockComponents, typeof renderKeys[number]>>;
type CollectedItemComponents = DeepReadonly<Pick<ItemComponents, typeof itemKeys[number]>>;
type PermutationCondition = MolangExpression | { readonly expression: string; readonly version: number };

function renderComponents(value?: JsonObject): CollectedBlockComponents {
  const result: CollectedBlockComponents = {};

  for (const key of renderKeys) {
    if (value?.[key] !== undefined) {
      Reflect.set(result, key, value[key]);
    }
  }

  return result;
}

function itemComponents(value: JsonObject): CollectedItemComponents {
  const result: CollectedItemComponents = {};

  for (const key of itemKeys) {
    if (value[key] !== undefined) {
      Reflect.set(result, key, value[key]);
    }
  }

  return result;
}

function blockTextureBindings(value: unknown): value is BlockTextureBindings {
  return typeof value === 'string' || (object(value) && Object.values(value).every(alias => typeof alias === 'string'));
}

function textureDefinition(value: unknown): value is string | DeepReadonly<TextureAtlasEntry> {
  if (typeof value === 'string') {
    return true;
  }

  if (!object(value)) {
    return false;
  }

  const pathEntry = (entry: unknown): boolean => object(entry) && typeof entry.path === 'string'
    && (entry.weight === undefined || typeof entry.weight === 'number')
    && (entry.quad === undefined || typeof entry.quad === 'boolean' || typeof entry.quad === 'number')
    && [entry.overlay_color, entry.tint_color].every(color => color === undefined || typeof color === 'string');
  const variant = (entry: unknown): boolean => typeof entry === 'string' || pathEntry(entry)
    || (object(entry) && Array.isArray(entry.variations) && entry.variations.every(pathEntry));

  return (value.additive === undefined || typeof value.additive === 'boolean')
    && [value.overlay_color, value.tint_color].every(color => color === undefined || typeof color === 'string')
    && (variant(value.textures) || (Array.isArray(value.textures) && value.textures.every(variant)));
}

function flipbookEntry(value: unknown): value is DeepReadonly<FlipbookTexture> {
  if (!object(value) || typeof value.flipbook_texture !== 'string' || typeof value.atlas_tile !== 'string') {
    return false;
  }

  return ['ticks_per_frame', 'atlas_index', 'atlas_tile_variant', 'replicate'].every(key => value[key] === undefined || typeof value[key] === 'number')
    && (value.blend_frames === undefined || typeof value.blend_frames === 'boolean')
    && (value.frames === undefined || typeof value.frames === 'number' || (Array.isArray(value.frames) && value.frames.every(frame => typeof frame === 'number')));
}

function clientEntity(value: unknown): value is EntityAsset {
  if (!object(value) || typeof value.format_version !== 'string') {
    return false;
  }

  const entity = value['minecraft:client_entity'];

  return object(entity) && object(entity.description) && typeof entity.description.identifier === 'string';
}

function emptyBlock(id: string): BlockAsset {
  return { 'format_version': '1.26.0', 'minecraft:block': { description: { identifier: id }, components: {} } };
}

function condition(value: JsonValue): PermutationCondition {
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }

  if (object(value) && typeof value.expression === 'string' && typeof value.version === 'number') {
    return { expression: value.expression, version: value.version };
  }

  throw new Error('Invalid native block permutation condition');
}

function paths(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') {
    return [texturePath(value)];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(paths))];
  }

  if (object(value)) {
    return [...new Set(['path', 'textures', 'variations'].flatMap(key => paths(value[key])))];
  }

  return [];
}

function set<T>(entries: Record<string, T>, id: string, value: T, source: string): void {
  if (Object.hasOwn(entries, id) && JSON.stringify(entries[id]) !== JSON.stringify(value)) {
    throw new Error(`Conflicting asset ${id} in ${source}`);
  }

  entries[id] = value;
}

export function linkedResources(owner: PackInfo, packs: readonly PackInfo[]): PackInfo[] {
  const seen = new Set<string>();

  const visit = (pack: PackInfo): void => {
    for (const dependency of pack.dependencies ?? []) {
      if (dependency.kind !== 'local' || seen.has(dependency.packId)) {
        continue;
      }

      const resource = packs.find(candidate => candidate.id === dependency.packId && candidate.kind === 'resource');

      if (resource) {
        seen.add(resource.id);
        visit(resource);
      }
    }
  };

  visit(owner);

  return packs.filter(pack => seen.has(pack.id));
}

async function files(directory: string, inputs: Set<string>, directories: Set<string>, excluded: ReadonlySet<string>): Promise<string[]> {
  directories.add(directory);
  const found: string[] = [];
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return found;
    }

    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...await files(file, inputs, directories, excluded));
    } else if (entry.isFile() && /\.jsonc?$/i.test(entry.name) && !excluded.has(fileKey(file))) {
      inputs.add(file);
      found.push(file);
    }
  }

  return found;
}

async function document(file: string, inputs: Set<string>, excluded: ReadonlySet<string>): Promise<JsonValue | undefined> {
  if (excluded.has(fileKey(file))) {
    return undefined;
  }

  let text;

  inputs.add(file);

  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  inputs.add(file);
  const errors: ParseError[] = [];
  const value: unknown = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });

  if (errors.length) {
    throw new Error(`Invalid asset JSON in ${file}: ${printParseErrorCode(errors[0].error)} at ${errors[0].offset}`);
  }

  return value as JsonValue;
}

/** Collect a behavior pack's own blocks and the visuals supplied by its linked resource packs. */
export async function collectPackAssets(owner: PackInfo, packs: readonly PackInfo[], options: { excluded?: readonly string[] } = {}): Promise<CollectedAssets> {
  const inputs = new Set<string>();
  const directories = new Set<string>();
  const excluded = new Set((options.excluded ?? []).map(fileKey));
  const items = dictionary<ItemAsset>();
  const bundle: AssetBundle = { schemaVersion: 2, revision: 0, textures: dictionary(), models: dictionary(), blocks: dictionary(), entities: dictionary(), items };
  const resources = linkedResources(owner, packs);
  const blockTextures = dictionary<BlockTextureBindings>();
  const carriedTextures = dictionary<BlockTextureBindings>();
  const flipbooks = dictionary<DeepReadonly<FlipbookTexture>>();

  for (const resource of resources) {
    inputs.add(path.join(resource.path, 'manifest.json'));
    directories.add(resource.path);
    directories.add(path.join(resource.path, 'textures'));

    for (const atlas of ['terrain_texture', 'item_texture']) {
      const file = path.join(resource.path, 'textures', `${atlas}.json`);
      const value = await document(file, inputs, excluded);

      if (object(value) && object(value.texture_data)) {
        for (const [id, definition] of Object.entries(value.texture_data)) {
          if (!textureDefinition(definition)) {
            throw new Error(`Invalid texture definition ${id} in ${file}`);
          }

          set(bundle.textures, atlas === 'item_texture' ? `item:${id}` : id, { definition, paths: paths(object(definition) ? definition.textures : definition) }, file);
        }
      }
    }

    const textureBindings = await document(path.join(resource.path, 'blocks.json'), inputs, excluded);

    if (object(textureBindings)) {
      for (const [id, definition] of Object.entries(textureBindings)) {
        if (object(definition)) {
          const name = id.includes(':') ? id : `minecraft:${id}`;

          if (blockTextureBindings(definition.textures)) {
            set(blockTextures, name, definition.textures, resource.path);
          }

          if (blockTextureBindings(definition.carried_textures)) {
            set(carriedTextures, name, definition.carried_textures, resource.path);
          }
        }
      }
    }

    const animation = await document(path.join(resource.path, 'textures', 'flipbook_textures.json'), inputs, excluded);

    if (Array.isArray(animation)) {
      for (const entry of animation) {
        if (!flipbookEntry(entry)) {
          throw new Error(`Invalid flipbook entry in ${resource.path}`);
        }

        for (const id of [entry.atlas_tile, entry.flipbook_texture]) {
          set(flipbooks, texturePath(id), entry, resource.path);
        }
      }
    }

    for (const file of await files(path.join(resource.path, 'models'), inputs, directories, excluded)) {
      const value = await document(file, inputs, excluded);

      if (!object(value)) {
        continue;
      }

      for (const geometry of Array.isArray(value['minecraft:geometry']) ? value['minecraft:geometry'] : []) {
        if (object(geometry) && object(geometry.description) && typeof geometry.description.identifier === 'string') {
          set(bundle.models, geometry.description.identifier, { geometry, ...(typeof value.format_version === 'string' ? { formatVersion: value.format_version } : {}) }, file);
        }
      }

      for (const [id, geometry] of Object.entries(value)) {
        if (id.startsWith('geometry.') && object(geometry)) {
          set(bundle.models, id, { geometry, ...(typeof value.format_version === 'string' ? { formatVersion: value.format_version } : {}) }, file);
        }
      }
    }

    for (const file of await files(path.join(resource.path, 'entity'), inputs, directories, excluded)) {
      const value = await document(file, inputs, excluded);
      const entity = object(value) ? value['minecraft:client_entity'] : undefined;
      const description = object(entity) ? entity.description : undefined;

      if (object(value) && object(description) && typeof description.identifier === 'string') {
        const document = { ...value, format_version: typeof value?.format_version === 'string' ? value.format_version : '1.10.0' };

        if (clientEntity(document)) {
          set(bundle.entities, description.identifier, document, file);
        }
      }
    }
  }

  for (const entity of Object.values(bundle.entities)) {
    const description = entity['minecraft:client_entity'].description;

    if (object(description.textures)) {
      for (const value of Object.values(description.textures ?? {})) {
        if (typeof value === 'string') {
          const id = texturePath(value);

          set(bundle.textures, id, { definition: value, paths: [id] }, 'client entity');

          if (value !== id) {
            set(bundle.textures, value, { definition: value, paths: [id] }, 'client entity');
          }
        }
      }
    }
  }

  for (const file of await files(path.join(owner.path, 'blocks'), inputs, directories, excluded)) {
    const value = await document(file, inputs, excluded);
    const block = object(value) ? value['minecraft:block'] : undefined;
    const description = object(block) ? block.description : undefined;

    if (!object(block) || !object(description) || typeof description.identifier !== 'string') {
      continue;
    }

    const id = description.identifier;
    const components = renderComponents(object(block.components) ? block.components : undefined);
    const permutations = Array.isArray(block.permutations)
      ? block.permutations.flatMap(entry => object(entry) && entry.condition !== undefined && object(entry.components)
          ? [{ condition: condition(entry.condition), components: renderComponents(entry.components) }]
          : [])
      : [];
    const visualPermutations = permutations.filter(permutation => Object.keys(permutation.components).length > 0);

    if (!id.startsWith('minecraft:') && !Object.hasOwn(components, 'minecraft:geometry')) {
      Reflect.set(components, 'minecraft:geometry', 'minecraft:geometry.full_block');
    }

    const renderDescription: BlockAsset['minecraft:block']['description'] = { identifier: id };

    if (object(block.description) && block.description.states !== undefined) {
      Object.defineProperty(renderDescription, 'states', { value: block.description.states, enumerable: true });
    }

    set(bundle.blocks, id, { 'format_version': object(value) && typeof value.format_version === 'string' ? value.format_version : '1.26.0',
      'minecraft:block': { description: renderDescription, components, ...(visualPermutations.length ? { permutations: visualPermutations } : {}) },
      ...(blockTextures[id] === undefined ? {} : { textures: blockTextures[id] }), ...(carriedTextures[id] === undefined ? {} : { carried_textures: carriedTextures[id] }) }, file);
    items[id] = { 'format_version': '1.26.0', 'minecraft:item': { description: { identifier: id }, components: {} }, 'block': { id } };
  }

  for (const [id, textures] of Object.entries(blockTextures)) {
    if (!Object.hasOwn(bundle.blocks, id)) {
      bundle.blocks[id] = { ...emptyBlock(id), textures, ...(carriedTextures[id] === undefined ? {} : { carried_textures: carriedTextures[id] }) };
    }
  }

  for (const [id, textures] of Object.entries(carriedTextures)) {
    bundle.blocks[id] ??= { ...emptyBlock(id), carried_textures: textures };
  }

  const authoredItems = new Set<string>();

  for (const file of await files(path.join(owner.path, 'items'), inputs, directories, excluded)) {
    const value = await document(file, inputs, excluded);
    const item = object(value) ? value['minecraft:item'] : undefined;
    const description = object(item) ? item.description : undefined;

    if (!object(item) || !object(description) || typeof description.identifier !== 'string') {
      continue;
    }

    const components = object(item.components) ? item.components : {};
    const icon = components['minecraft:icon'];
    const icons = typeof icon === 'string' ? { default: icon } : object(icon) && object(icon.textures) ? icon.textures : object(icon) && typeof icon.texture === 'string' ? { default: icon.texture } : {};
    const textures = Object.fromEntries(Object.entries(icons).filter(([, alias]) => typeof alias === 'string').map(([slot, alias]) => [slot, { id: `item:${String(alias)}` }]));
    const placer = components['minecraft:block_placer'];
    const block = object(placer) && typeof placer.block === 'string' ? { id: placer.block } : items[description.identifier]?.block;

    if (!authoredItems.has(description.identifier)) {
      delete items[description.identifier];
    }

    set(items, description.identifier, { 'format_version': object(value) && typeof value.format_version === 'string' ? value.format_version : '1.26.0', 'minecraft:item': { description: { identifier: description.identifier }, components: itemComponents(components) }, ...(Object.keys(textures).length ? { textures } : {}), ...(block === undefined ? {} : { block }) }, file);
    authoredItems.add(description.identifier);
  }

  for (const texture of Object.values(bundle.textures)) {
    const flipbook = flipbooks[texture.paths[0]];

    if (flipbook) {
      texture.flipbook = flipbook;
    }
  }

  for (const [id, texture] of Object.entries(bundle.textures)) {
    if (flipbooks[id]) {
      texture.flipbook = flipbooks[id];
    }

    for (const name of texture.paths) {
      if (!Object.hasOwn(bundle.textures, name)) {
        bundle.textures[name] = { definition: name, paths: [name], ...(flipbooks[name] ? { flipbook: flipbooks[name] } : {}) };
      }
    }
  }

  bundle.revision = assetRevision(bundle);

  return { bundle, inputs: [...inputs].sort(), directories: [...directories].sort() };
}

/** Find the installed Core runtime's asset publisher without loading addon code. */
export async function coreAssetPublisher(projectRoot: string): Promise<string | undefined> {
  const require = createRequire(path.join(projectRoot, 'package.json'));

  for (const directory of require.resolve.paths('@bedrock-core/server-runtime') ?? []) {
    const file = path.join(directory, '@bedrock-core/server-runtime/package.json');
    let metadata: unknown;

    try {
      metadata = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    if (object(metadata) && object(metadata.exports) && Object.hasOwn(metadata.exports, './assets/publish')) {
      return file;
    }

    return undefined;
  }

  return undefined;
}
