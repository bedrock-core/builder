import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../files.ts';
import { object, type SchemaNode } from '../schema/normalize.ts';

const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

/** Resolve block components from the release's native metadata or its SDK catalog. */
export async function normalizeBlocks(source: string, componentVersion: string): Promise<string> {
  const native = `metadata/server/block_components/${componentVersion}/Block Components.json`;
  const original = 'bp/blocks/block_components.schema.json';
  const hasNative = await exists(path.join(source, 'schemas', native));
  const component = hasNative ? native : original.replace('.schema.json', '.native.schema.json');

  if (hasNative) {
    await allowSingleCollisionBox(path.join(source, 'schemas', path.dirname(native), 'Collision Box.json'));
  } else {
    await normalizeSdkBlocks(path.join(source, 'schemas', original), path.join(source, 'schemas', component));
  }

  const wrapper = path.join(source, 'schemas/assets/block-components/index.schema.json');
  const descriptionFile = path.join(source, 'schemas/bp/blocks/block_description.schema.json');

  if (await exists(descriptionFile)) {
    const description = JSON.parse(await readFile(descriptionFile, 'utf8')) as SchemaNode;
    const states = object(object(description.properties)?.states);

    if (states) {
      states.tsType = 'BlockStates';
      await writeFile(descriptionFile, JSON.stringify(description));
    }
  }

  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(
    wrapper,
    JSON.stringify({
      title: 'BlockComponents',
      $ref: '../../' + component.replaceAll(' ', '%20'),
    }),
  );
  await writeFile(
    path.join(source, 'schemas', original),
    JSON.stringify({
      tsType: 'BlockComponents',
    }),
  );
  const catalogFile = path.join(source, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));

  catalog.schemas.push({
    url: './schemas/assets/block-components/index.schema.json',
  });
  await writeFile(catalogFile, JSON.stringify(catalog));

  return (hasNative ? 'samples metadata ' : 'schema SDK ') + componentVersion;
}

async function allowSingleCollisionBox(file: string): Promise<void> {
  if (!(await exists(file))) {
    return;
  }

  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const variants = schema.oneOf;

  if (Array.isArray(variants) && variants.length === 2 && variants.some((variant: SchemaNode) => variant.type === 'boolean')) {
    const list = variants.find((variant: SchemaNode) => variant.type === 'array');

    if (object(list?.items)) {
      variants.push(list.items);
      await writeFile(file, JSON.stringify(schema));
    }
  }
}

async function normalizeSdkBlocks(file: string, target: string): Promise<void> {
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const properties = object(schema.properties);
  const geometry = object(properties?.['minecraft:geometry']);
  const variants = geometry?.anyOf;
  const details = Array.isArray(variants) ? variants.find((variant: SchemaNode) => variant.type === 'object') : undefined;
  const geometryProperties = object(details?.properties);

  if (!properties || !geometry || !details || !geometryProperties) {
    throw new Error('Missing SDK block component definitions');
  }

  delete schema.$id;
  details.required = ['identifier'];
  geometryProperties.bone_visibility = {
    type: 'object',
    additionalProperties: {
      anyOf: [
        { type: 'boolean' },
        { $ref: '../../common/expression.schema.json' },
        { type: 'object', properties: { expression: { type: 'string' }, version: { type: 'integer' } }, required: ['expression', 'version'] },
      ],
    },
  };
  geometryProperties.uv_lock = { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' }, maxItems: 64 }] };

  const material = {
    title: 'MaterialInstances',
    type: 'object',
    additionalProperties: {
      anyOf: [
        { type: 'string' },
        {
          title: 'MaterialInstance',
          type: 'object',
          properties: {
            texture: { type: 'string' },
            render_method: {
              enum: ['opaque', 'double_sided', 'blend', 'alpha_test', 'alpha_test_single_sided', 'blend_to_opaque', 'alpha_test_to_opaque', 'alpha_test_single_sided_to_opaque'],
            },
            // Boolean values are accepted only by legacy block formats.
            // https://learn.microsoft.com/minecraft/creator/reference/content/blockreference/examples/blockcomponents/minecraftblock_material_instances
            ambient_occlusion: { type: 'number' },
            face_dimming: { type: 'boolean' },
            isotropic: { type: 'boolean' },
            alpha_masked_tint: { type: 'boolean' },
            tint_method: { enum: ['none', 'default_foliage', 'birch_foliage', 'evergreen_foliage', 'dry_foliage', 'grass', 'water'] },
          },
        },
      ],
    },
  };

  properties['minecraft:material_instances'] = material;
  properties['minecraft:item_visual'] = {
    type: 'object',
    properties: { geometry, material_instances: material },
    required: ['geometry', 'material_instances'],
  };
  properties['minecraft:transformation'] = {
    title: 'Transformation',
    type: 'object',
    properties: { rotation: vector, scale: vector, translation: vector, rotation_pivot: vector, scale_pivot: vector },
  };
  const bounds = {
    title: 'BoundingBoxData',
    type: 'object',
    properties: { origin: vector, size: vector, min: vector, max: vector },
  };

  properties['minecraft:collision_box'] = {
    title: 'CollisionBox',
    anyOf: [{ type: 'boolean' }, bounds, { type: 'array', minItems: 0, maxItems: 16, items: bounds }],
  };
  await writeFile(target, JSON.stringify(schema));
}
