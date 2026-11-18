import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCatalogSchema } from '../schema/catalog.ts';
import { exists } from '../files.ts';
import { object, type SchemaNode } from '../schema/normalize.ts';

async function normalizeSurfaceBuilders(source: string, directory: string): Promise<void> {
  const surface = path.join(directory, 'biome_minecraft_surface_builder.schema.json');
  const subsurface = path.join(directory, 'biome_minecraft_subsurface_builder.schema.json');
  const noiseFile = path.join(source, 'schemas/metadata/server/biome/1.26.30/minecraft_noise_gradient.json');
  const [surfaceSchema, subsurfaceSchema, noiseSchema] = await Promise.all([surface, subsurface, noiseFile].map(async file =>
    JSON.parse(await readFile(file, 'utf8')) as SchemaNode));
  const builder = object(object(surfaceSchema.properties)?.builder);
  const subsurfaceFields = object(subsurfaceSchema.properties);
  const noiseFields = object(noiseSchema.properties);
  const noiseType = 'minecraft:noise_gradient';

  if (!Array.isArray(builder?.anyOf) || !subsurfaceFields || !noiseFields || object(noiseFields.type)?.const !== noiseType) {
    throw new Error('Missing SDK biome builders or native noise gradient');
  }

  // Each SDK variant lists every builder type. Reserve the noise gradient discriminator for its native schema.
  await Promise.all(builder.anyOf.map(async (variant) => {
    const reference = object(variant)?.$ref;

    if (typeof reference !== 'string' || reference !== './' + path.basename(reference)) {
      throw new Error('Expected a local SDK surface builder reference');
    }

    const file = path.join(directory, reference);
    const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
    const type = object(object(schema.properties)?.type);

    if (type && Array.isArray(type.enum) && type.enum.includes(noiseType)) {
      type.enum = type.enum.filter(value => value !== noiseType);
      await writeFile(file, JSON.stringify(schema));
    }
  }));

  noiseSchema.title = 'NoiseGradientSurfaceBuilder';
  noiseFields.type = { const: noiseType };
  builder.anyOf.push({ $ref: pathToFileURL(noiseFile).href });
  subsurfaceFields.builder = { $ref: './biome_minecraft_surface_builder.schema.json#/properties/builder' };
  await Promise.all([
    writeFile(surface, JSON.stringify(surfaceSchema)),
    writeFile(subsurface, JSON.stringify(subsurfaceSchema)),
    writeFile(noiseFile, JSON.stringify(noiseSchema)),
  ]);
}

/** Preserve block lists and paired values and use native metadata for noise gradients. */
export async function normalizeBehaviorBiomes(source: string): Promise<void> {
  const directory = path.join(source, 'schemas/bp/biomes');
  const capped = path.join(directory, 'biome_minecraft_capped.schema.json');
  const surfaces = path.join(directory, 'biome_minecraft_surface_material_adjustments.schema.json');
  const generation = path.join(directory, 'biome_minecraft_overworld_generation_rules.schema.json');
  const [builder, adjustments, rules] = await Promise.all([capped, surfaces, generation].map(async file =>
    JSON.parse(await readFile(file, 'utf8')) as SchemaNode));
  const materials = object(builder.properties);
  const adjustment = object(object(object(adjustments.properties)?.adjustments)?.items);
  const height = object(object(adjustment?.properties)?.height_range);
  const hills = object(object(rules.properties)?.hills_transformation);

  if (!materials || !height || !hills || !Array.isArray(hills.anyOf)) {
    throw new Error('Missing upstream biome surface or generation settings');
  }

  for (const name of ['floor_materials', 'ceiling_materials']) {
    const material = object(materials[name]);

    if (!material || !Array.isArray(material.anyOf)) {
      throw new Error('Missing upstream capped surface material: ' + name);
    }

    for (const variant of material.anyOf) {
      const block = object(object(variant)?.properties);
      const name = object(block?.name);

      if (name?.type === 'object') {
        name.type = 'string';
      }
    }

    materials[name] = { type: 'array', items: material, minItems: 1, description: material.description };
  }

  delete height.anyOf;
  Object.assign(height, { type: 'array', items: { type: ['number', 'string'] }, minItems: 2, maxItems: 2 });
  hills.anyOf.push({ type: 'array', items: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2 } });
  await Promise.all([
    writeFile(capped, JSON.stringify(builder)),
    writeFile(surfaces, JSON.stringify(adjustments)),
    writeFile(generation, JSON.stringify(rules)),
  ]);
  await normalizeSurfaceBuilders(source, directory);
}

/** Compile client biomes from the pinned native schema and its full component references. */
export async function normalizeClientBiomes(source: string): Promise<void> {
  const root = path.join(source, 'schemas/metadata/client/biome');
  const versions = (await readdir(root)).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  const latest = async (name: string): Promise<string> => {
    for (const version of versions) {
      const file = path.join(root, version, name);

      if (await exists(file)) {
        return file;
      }
    }

    throw new Error('Missing native client-biome schema: ' + name);
  };

  const file = await latest('Client Biome Components.json');
  const components = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;

  for (const value of Object.values(object(components.properties) ?? {})) {
    const component = object(value);

    if (typeof component?.$ref !== 'string') {
      continue;
    }

    const previous = fileURLToPath(component.$ref);
    const current = await latest(path.basename(previous));

    if (previous !== current) {
      const original = JSON.parse(await readFile(previous, 'utf8')) as SchemaNode;
      const replacement = JSON.parse(await readFile(current, 'utf8')) as SchemaNode;
      const oldProperties = object(original.properties);
      const newProperties = object(replacement.properties);

      if (oldProperties?.addition && newProperties?.addition) {
        newProperties.addition = { anyOf: [oldProperties.addition, newProperties.addition] };
        await writeFile(current, JSON.stringify(replacement));
      }

      component.$ref = pathToFileURL(current).href;
    }
  }

  await writeFile(file, JSON.stringify(components));
  const definitionFile = await latest('Client Biome Definition.json');
  const definition = JSON.parse(await readFile(definitionFile, 'utf8')) as SchemaNode;
  const properties = object(definition.properties);

  if (!properties) {
    throw new Error('Missing native client-biome definition properties');
  }

  properties.components = { $ref: pathToFileURL(file).href };
  await writeFile(definitionFile, JSON.stringify(definition));
  await writeCatalogSchema(source, 'rp/biomes', { $ref: pathToFileURL(await latest('Client Biome Document.json')).href });
}
