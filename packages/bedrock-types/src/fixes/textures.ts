import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeCatalogSchema } from '../schema/catalog.ts';
import { object, type SchemaNode } from '../schema/normalize.ts';

/** List resource-relative texture paths that the pack supplies. */
export async function normalizeTextureList(source: string): Promise<void> {
  await writeCatalogSchema(source, 'rp/textures/texture_list', { type: 'array', items: { type: 'string' } });
}

/** Describe native block-name entries alongside the blocks.json format marker. */
export async function normalizeBlockTextures(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/textures/blocks_resource.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;

  schema.additionalProperties = { anyOf: [
    { type: 'string' },
    { tsType: 'undefined' },
    {
      title: 'BlockResourceDefinition',
      type: 'object',
      properties: {
        sound: { type: 'string' },
        sounds: { type: 'string' },
        ambient_occlusion_exponent: { type: 'number' },
        textures: { tsType: 'BlockTextureBindings' },
        carried_textures: { tsType: 'BlockTextureBindings' },
        isotropic: { anyOf: [{ type: 'boolean' }, { tsType: 'Partial<Record<BlockTextureFace, boolean>>' }] },
      },
    },
  ] };
  await writeFile(file, JSON.stringify(schema));
}

/** Compile a flipbook file as an array, retaining the individual animation entry type. */
export async function normalizeFlipbooks(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/textures/flipbook_textures.schema.json');
  const original = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const entry = {
    title: 'FlipbookTexture',
    description: 'Animation parameters for one texture in an atlas.',
    type: 'object',
    properties: {
      ...object(original.properties),
      atlas_index: { type: 'integer', minimum: 0 },
      atlas_tile_variant: { type: 'integer', minimum: 0 },
      frames: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'array', items: { type: 'integer', minimum: 0 } }] },
      replicate: { type: 'integer', minimum: 1 },
      blend_frames: { type: 'boolean' },
    },
    required: ['flipbook_texture', 'atlas_tile'],
  };

  await writeFile(file, JSON.stringify({ ...original, type: 'array', properties: undefined, items: entry }));
}

/** Share atlas entry types across block and item texture documents. */
export async function normalizeTextureAtlases(source: string, categories: readonly string[]): Promise<void> {
  for (const name of ['terrain_texture', 'item_texture']) {
    if (!categories.includes('rp/textures/' + name)) {
      continue;
    }

    const file = path.join(source, 'schemas/rp/textures', name + '.schema.json');
    const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
    const properties = object(schema.properties);

    if (!properties || !object(properties.texture_data)) {
      throw new Error('Missing upstream texture atlas entries: ' + name);
    }

    (properties.texture_data as SchemaNode).tsType = 'Record<string, TextureAtlasEntry>';

    if (name === 'item_texture') {
      properties.default_leather_color = { type: 'string' };
      properties.default_leather_horse_armor_color = { type: 'string' };
    }

    await writeFile(file, JSON.stringify(schema));
  }
}

/** Restore the texture-set document wrapper and supported image/uniform layer alternatives. */
export async function normalizeTextureSets(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/textures/texture_set.schema.json');
  const original = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const properties = original.properties as Record<string, SchemaNode>;

  const uniform = (name: string, channels: number): SchemaNode => ({
    ...properties[name],
    type: undefined,
    description: 'Texture image, hexadecimal value or uniform channel values from 0 to 255.',
    anyOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'number', minimum: 0, maximum: 255 }, minItems: channels, maxItems: channels },
    ],
  });
  const alternatives = (name: string, left: string, leftType: SchemaNode, right: string, rightType: SchemaNode): SchemaNode => ({
    title: name,
    anyOf: [
      { type: 'object', properties: { [left]: leftType, [right]: { tsType: 'never' } } },
      { type: 'object', properties: { [left]: { tsType: 'never' }, [right]: rightType } },
    ],
  });
  const layers: SchemaNode = {
    title: 'TextureSet',
    description: 'Color and optional surface/material layers for one texture resource.',
    allOf: [
      { type: 'object', properties: { color: uniform('color', 4) }, required: ['color'] },
      alternatives('TextureSetSurface', 'normal', properties.normal, 'heightmap', {
        ...properties.heightmap,
        type: ['string', 'number'],
        description: 'Heightmap texture, hexadecimal value or uniform height from 0 to 255.',
        minimum: 0,
        maximum: 255,
      }),
      alternatives('TextureSetMaterial', 'metalness_emissive_roughness', uniform('metalness_emissive_roughness', 3),
        'metalness_emissive_roughness_subsurface', uniform('metalness_emissive_roughness_subsurface', 4)),
    ],
  };

  await writeFile(file, JSON.stringify({
    $schema: original.$schema,
    title: 'TextureSetDocument',
    description: 'A texture-set file defining image references and uniform PBR layer values.',
    type: 'object',
    properties: { 'format_version': { type: 'string' }, 'minecraft:texture_set': layers },
    required: ['format_version', 'minecraft:texture_set'],
  }));
}
