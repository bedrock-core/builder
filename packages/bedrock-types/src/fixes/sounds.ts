import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeCatalogSchema } from '../schema/catalog.ts';
import { object, type SchemaNode } from '../schema/normalize.ts';

/** Compile the bare-path and named-object forms of a resource-pack sound. */
export async function normalizeSoundDefinitions(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/sounds/index.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const definitions = object(object(schema.properties)?.sound_definitions);
  const event = object(definitions?.additionalProperties);
  const fields = object(event?.properties);
  const sounds = object(fields?.sounds);
  const entry = object(sounds?.items);

  if (fields && sounds && entry) {
    // https://learn.microsoft.com/minecraft/creator/documents/addcustomsounds
    sounds.items = { anyOf: [{ type: 'string' }, { ...entry, required: ['name'] }] };
    fields.subtitle = { type: 'string', description: 'Localization key for the sound caption.' };
    await writeFile(file, JSON.stringify(schema));
  }
}

/** Index music events by the name referenced from a client biome. */
export async function normalizeMusicDefinitions(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/sounds/music_definitions.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const music = object(object(schema.properties)?.biome_music);
  const entry = object(music?.additionalProperties);

  if (!entry) {
    throw new Error('Missing upstream music definition entries');
  }

  await writeFile(file, JSON.stringify({ description: schema.description, type: 'object', additionalProperties: entry }));
}

/** Define the event bindings in root sounds.json independently of sound definitions. */
export async function normalizeSoundEvents(source: string): Promise<void> {
  const reference = (name: string): SchemaNode => ({ $ref: '#/definitions/' + name });
  const dictionary = (value: SchemaNode): SchemaNode => ({ type: 'object', additionalProperties: value });
  const range: SchemaNode = { title: 'SoundValue', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] };
  const settings = { pitch: range, volume: range };
  const group = (events: SchemaNode, name: string): SchemaNode => ({ type: 'object', properties: {
    ...settings,
    base: { type: 'string' },
    events: dictionary(events),
    variants: { type: 'object', properties: { key: { type: 'string' }, map: dictionary(reference(name)) }, required: ['key', 'map'] },
  } });
  const entities = (value: SchemaNode): SchemaNode => ({ type: 'object', properties: { defaults: value, entities: dictionary(value) } });
  const event = reference('SoundEventDefinition');
  const groupRef = reference('SoundEventGroup');
  const interactionRef = reference('SoundInteractionGroup');

  await writeCatalogSchema(source, 'rp/sounds/events', {
    title: 'SoundEventsDocument',
    description: 'Block, entity and individual event bindings from the resource pack sounds.json file.',
    type: 'object',
    properties: {
      block_sounds: dictionary(groupRef),
      entity_sounds: entities(groupRef),
      individual_event_sounds: groupRef,
      individual_named_sounds: { type: 'object', properties: { sounds: dictionary(event) } },
      interactive_sounds: { type: 'object', properties: {
        block_sounds: dictionary(groupRef),
        entities: { anyOf: [dictionary(interactionRef), { type: 'null' }] },
        entity_sounds: entities(interactionRef),
      } },
    },
    definitions: {
      SoundEventDefinition: { title: 'SoundEventDefinition', anyOf: [
        { type: 'string' },
        { type: 'object', properties: { sound: { type: 'string' }, sounds: { type: 'string' }, ...settings } },
      ] },
      SoundEventGroup: { title: 'SoundEventGroup', ...group(event, 'SoundEventGroup') },
      SoundInteractionGroup: { title: 'SoundInteractionGroup', ...group(dictionary(event), 'SoundInteractionGroup') },
    },
  });
}
