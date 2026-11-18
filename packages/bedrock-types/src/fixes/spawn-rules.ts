import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { object, type SchemaNode } from '../schema/normalize.ts';

/** Use the same test and recursive groups throughout a biome filter. */
export async function normalizeSpawnRules(source: string): Promise<void> {
  const directory = path.join(source, 'schemas/bp/spawn_rules');
  const file = path.join(directory, 'spawn_spawn_biomeconditions.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const fields = object(schema.properties);
  const filter = object(fields?.['minecraft:biome_filter']);
  const alternatives = filter?.anyOf;
  const test = Array.isArray(alternatives)
    ? alternatives.find(alternative => object(object(alternative)?.properties)?.test)
    : undefined;
  const testFields = object(object(test)?.properties);

  if (!fields || !testFields) {
    throw new Error('Missing upstream spawn biome filter');
  }

  const group = { type: 'array', items: { $ref: '#' } };
  const definition = {
    title: 'SpawnBiomeFilter',
    description: filter?.description,
    anyOf: [
      {
        type: 'object',
        properties: {
          ...testFields,
          value: { ...object(testFields.value), type: ['string', 'integer', 'boolean'] },
          all_of: group, any_of: group, none_of: group,
        },
      },
      group,
    ],
  };

  fields['minecraft:biome_filter'] = { $ref: './spawn_biome_filter.schema.json' };
  await writeFile(path.join(directory, 'spawn_biome_filter.schema.json'), JSON.stringify(definition));
  await writeFile(file, JSON.stringify(schema));
}
