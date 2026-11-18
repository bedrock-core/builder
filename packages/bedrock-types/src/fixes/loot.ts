import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { object, type SchemaNode } from '../schema/normalize.ts';

function namedPayloads(
  schema: SchemaNode,
  fields: SchemaNode,
  discriminant: 'function' | 'condition',
  variants: Record<string, Record<string, SchemaNode>>,
): SchemaNode {
  const keys = new Set(Object.values(variants).flatMap(variant => Object.keys(variant)));
  const shared = Object.fromEntries(Object.entries(fields).filter(([name]) => !keys.has(name)));
  const fallback = Object.fromEntries([...keys].map(name => [name, fields[name] ?? { tsType: 'never' }]));
  const alternatives = [
    { type: 'object', properties: fallback },
    ...Object.entries(variants).map(([name, properties]) => ({
      type: 'object',
      properties: { ...fallback, ...properties, [discriminant]: { enum: [name, 'minecraft:' + name] } },
      required: [discriminant],
    })),
  ];

  return {
    title: schema.title,
    description: schema.description,
    allOf: [
      { type: 'object', properties: shared, required: schema.required ?? [discriminant] },
      { anyOf: alternatives },
    ],
  };
}

/** Keep shared SDK fields and attach additional payloads to the functions that use them. */
export async function normalizeLootTables(source: string): Promise<void> {
  const directory = path.join(source, 'schemas/bp/loot_tables');
  const file = path.join(directory, 'loot_loot_function.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const fields = object(schema.properties);
  const data = object(fields?.data);
  const damage = object(fields?.damage);
  const levels = object(fields?.levels);

  if (!fields || !data || !damage || !levels) {
    throw new Error('Missing upstream loot function fields');
  }

  const number = { type: 'number' };
  const add = { type: 'boolean' };
  const string = { type: 'string' };
  const scalarOrRange = (range: SchemaNode): SchemaNode => ({ anyOf: [number, range] });
  const range = { type: 'object', properties: { min: number, max: number } };
  const enchantment = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      level: { anyOf: [number, range, { type: 'array', items: number, minItems: 2, maxItems: 2 }] },
    },
    required: ['id'],
  };
  const variants: Record<string, Record<string, SchemaNode>> = {
    set_count: { add },
    set_data: { data: scalarOrRange(data) },
    set_damage: { add, damage: scalarOrRange(damage) },
    enchant_with_levels: { levels: scalarOrRange(levels) },
    enchant_random_gear: { chance: number },
    specific_enchants: { enchants: { type: 'array', items: { anyOf: [{ type: 'string' }, enchantment] } } },
    set_ominous_bottle_amplifier: { amplifier: scalarOrRange(range) },
    set_banner_details: { type: number },
    set_armor_trim: { material: string, pattern: string },
    set_stew_effect: {
      effects: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    },
    looting_enchant: { limit: number },
    enchant_book_for_trading: {
      base_cost: number, base_random_cost: number, per_level_cost: number, per_level_random_cost: number,
      enchantments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: string, min: { type: 'integer' }, max: { type: 'integer' } },
          required: ['name', 'min', 'max'],
        },
      },
    },
    random_aux_value: { values: scalarOrRange(range) },
  };
  const conditionsFile = path.join(directory, 'loot_loot_condition.schema.json');
  const conditions = JSON.parse(await readFile(conditionsFile, 'utf8')) as SchemaNode;
  const conditionFields = object(conditions.properties);
  const entryFile = path.join(directory, 'loot_loot_entry.schema.json');
  const entry = JSON.parse(await readFile(entryFile, 'utf8')) as SchemaNode;
  const entryFields = object(entry.properties);
  const poolFile = path.join(directory, 'loot_loot_pool.schema.json');
  const { title, description, ...populatedPool } = JSON.parse(await readFile(poolFile, 'utf8')) as SchemaNode;
  const emptyPool = {
    type: 'object', additionalProperties: false,
    tsType: 'Record<string, never> & { entries?: never }',
  };

  if (!conditionFields || !entryFields) {
    throw new Error('Missing upstream loot condition or entry fields');
  }

  const entity = { entity_type: string };
  const conditionVariants = {
    random_regional_difficulty_chance: { max_chance: number },
    bool_property: { value: { type: 'boolean' }, domain: string },
    biome_has_tag: { tag: string, operator: string },
    entity_killed: entity,
    killed_by_entity: entity,
    passenger_of_entity: entity,
    damaged_by_entity: entity,
  };

  entryFields.quality = { type: 'integer', description: 'Adjusts the entry weight based on player luck.' };
  await Promise.all([
    writeFile(file, JSON.stringify(namedPayloads(schema, fields, 'function', variants))),
    writeFile(conditionsFile, JSON.stringify(namedPayloads(conditions, conditionFields, 'condition', conditionVariants))),
    writeFile(entryFile, JSON.stringify(entry)),
    writeFile(poolFile, JSON.stringify({ title, description, anyOf: [populatedPool, emptyPool] })),
  ]);
}
