import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../files.ts';
import { object, type SchemaNode } from '../schema/normalize.ts';

const sources = [
  { document: 'bp/entities', category: 'assets/entity-components', folder: 'bp/entities', file: 'entity_entity_component_definitions.schema.json', type: 'EntityComponents' },
] as const;

export function componentDependencies(categories: readonly string[]): string[] {
  return sources.filter(source => categories.includes(source.document)).map(source => source.category);
}

async function normalizeSpellEffects(directory: string): Promise<void> {
  const component = path.join(directory, 'entity_minecraft_spell_effects.schema.json');

  if (!(await exists(component))) {
    return;
  }

  const schema = JSON.parse(await readFile(component, 'utf8')) as SchemaNode;
  const fields = object(schema.properties);
  const removals = object(fields?.remove_effects);
  const additions = object(fields?.add_effects);
  const items = object(additions?.items);
  const reference = items?.$ref;

  if (typeof reference === 'string' && reference !== './' + path.basename(reference)) {
    throw new Error('Expected a local spell effect schema reference');
  }

  const file = typeof reference === 'string' ? path.join(directory, reference) : component;
  const effect = file === component ? items : JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const properties = object(effect?.properties);

  if (fields && removals?.type === 'array') {
    fields.remove_effects = {
      description: removals.description,
      anyOf: [{ type: 'string' }, removals],
    };
  }

  if (properties?.duration) {
    // https://learn.microsoft.com/minecraft/creator/reference/content/entityreference/examples/entitycomponents/minecraftcomponent_spell_effects
    properties.duration = {
      description: object(properties.duration)?.description,
      anyOf: [{ type: 'number' }, { const: 'infinite' }],
    };

    if (file !== component) {
      await writeFile(file, JSON.stringify(effect));
    }
  }

  await writeFile(component, JSON.stringify(schema));
}

const string = { type: 'string' };
const eventTrigger = {
  type: 'object',
  properties: { event: string, target: string, filters: { tsType: 'FilterGroup' } },
};

function itemAndResult(growth?: SchemaNode): SchemaNode {
  return {
    type: 'object',
    properties: { item: string, result_item: string, ...(growth && { growth }) },
    required: ['item'],
  };
}

function itemChoices(items: SchemaNode, entry: SchemaNode, scalar: boolean): SchemaNode {
  return {
    description: items.description,
    anyOf: [
      ...(scalar ? [string] : []),
      { type: 'array', items: { anyOf: [string, entry] } },
    ],
  };
}

function normalizeTransformation(fields: SchemaNode): void {
  for (const property of ['begin_transform_sound', 'transformation_sound']) {
    const sound = object(fields[property]);

    if (sound) {
      fields[property] = {
        description: sound.description,
        anyOf: [string, { type: 'array', items: string }],
      };
    }
  }
}

function normalizeBreedable(fields: SchemaNode): void {
  const items = object(fields.breed_items);
  const mates = object(fields.breeds_with);

  if (items) {
    fields.breed_items = itemChoices(items, itemAndResult(), true);
  }

  if (mates) {
    fields.breeds_with = {
      description: mates.description,
      anyOf: [mates, { type: 'object', additionalProperties: eventTrigger }],
    };
  }
}

function normalizeTempt(fields: SchemaNode): void {
  const items = object(fields.items);

  if (items) {
    const entry = {
      anyOf: [
        string,
        { type: 'object', properties: { name: string }, required: ['name'] },
        { type: 'object', properties: { tags: string }, required: ['tags'] },
      ],
    };

    fields.items = { description: items.description, anyOf: [items, { type: 'array', items: entry }] };
  }

  fields.on_tempt_start ??= eventTrigger;
  fields.on_tempt_end ??= eventTrigger;
}

async function normalizeEntityComponentFields(directory: string): Promise<void> {
  const updated = [
    'navigation_walk', 'navigation_generic', 'navigation_float', 'behavior_tempt', 'behavior_float_tempt', 'behavior_pickup_items',
    'transformation', 'ageable', 'tameable', 'breedable', 'healable', 'timer', 'behavior_swim_with_entity',
  ];

  for (const name of updated) {
    const file = path.join(directory, 'entity_minecraft_' + name + '.schema.json');

    if (!(await exists(file))) {
      continue;
    }

    const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
    const fields = object(schema.properties);

    if (!fields) {
      continue;
    }

    const annotation = object(fields.using_door_annotation);
    const excludedItems = object(fields.excluded_items);
    const feedItems = object(fields.feed_items);
    const tameItems = object(fields.tame_items);

    if (annotation?.type === 'string') {
      annotation.type = 'boolean';
    }

    if (name === 'behavior_tempt' || name === 'behavior_float_tempt') {
      normalizeTempt(fields);
    }

    if (name === 'behavior_pickup_items' && excludedItems) {
      const item = {
        anyOf: [
          string,
          { type: 'object', properties: { name: string }, required: ['name'] },
          { type: 'object', properties: { tags: string }, required: ['tags'] },
        ],
      };

      fields.excluded_items = {
        description: excludedItems.description,
        anyOf: [excludedItems, { type: 'array', items: item }],
      };
    }

    if (name === 'transformation') {
      normalizeTransformation(fields);
    }

    if (name === 'breedable') {
      normalizeBreedable(fields);
    }

    if (name === 'ageable' && feedItems) {
      fields.feed_items = itemChoices(feedItems, itemAndResult({ type: 'number' }), true);
    }

    if (name === 'tameable' && tameItems) {
      fields.tame_items = itemChoices(tameItems, itemAndResult(), false);
    }

    if (name === 'healable') {
      const item = object(object(fields.items)?.items);
      const properties = object(item?.properties);

      if (properties) {
        properties.result_item ??= {
          description: 'Item that replaces the feed item after a successful heal.',
          anyOf: [string, { type: 'object', additionalProperties: string }],
        };
      }
    }

    if (name === 'timer') {
      const choices = object(fields.random_time_choices);

      if (choices && object(choices.items)?.type === 'string') {
        choices.items = {
          type: 'object',
          properties: { value: { type: 'number', default: 0 }, weight: { type: 'integer', default: 0 } },
        };
      }
    }

    if (name === 'behavior_swim_with_entity') {
      const targets = object(fields.entity_types);

      if (targets && object(targets.items)?.type === 'string') {
        fields.entity_types = {
          description: targets.description,
          anyOf: [targets, {
            type: 'array',
            items: { type: 'object', properties: { filters: { tsType: 'FilterGroup' } }, required: ['filters'] },
          }],
        };
      }
    }

    await writeFile(file, JSON.stringify(schema));
  }
}

/** Compile component definitions once and reuse extensible maps throughout native documents. */
export async function normalizeComponentRegistries(root: string, categories: readonly string[]): Promise<void> {
  const catalogFile = path.join(root, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8')) as { schemas: { url: string }[] };

  for (const source of sources) {
    if (!categories.includes(source.category)) {
      continue;
    }

    const file = path.join(root, 'schemas', source.folder, source.file);
    const nativeFile = file.replace(/\.schema\.json$/, '.native.schema.json');
    const original = JSON.parse(await readFile(file, 'utf8'));

    await normalizeSpellEffects(path.dirname(file));
    await normalizeEntityComponentFields(path.dirname(file));
    delete original.$id;
    await writeFile(nativeFile, JSON.stringify(original));
    await writeFile(file, JSON.stringify({ tsType: source.type }));
    const wrapper = path.join(root, 'schemas', source.category, 'index.schema.json');

    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, JSON.stringify({ $ref: path.relative(path.dirname(wrapper), nativeFile).replaceAll('\\', '/') }));
    catalog.schemas.push({ url: './schemas/' + source.category + '/index.schema.json' });
  }

  await writeFile(catalogFile, JSON.stringify(catalog));
}
