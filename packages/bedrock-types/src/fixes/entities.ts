import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { exists } from '../files.ts';
import { object, type SchemaNode } from '../schema/normalize.ts';

/** Use the authored behavior description and response types for dynamic SDK fields. */
export async function normalizeBehaviorEntities(source: string): Promise<void> {
  const file = path.join(source, 'schemas/bp/entities/entity_actor_document.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const fields = object(schema.properties);

  if (!fields) {
    throw new Error('Missing SDK behavior entity definition');
  }

  fields.description = { description: object(fields.description)?.description, tsType: 'EntityDescription' };
  fields.events = { description: object(fields.events)?.description, tsType: 'Record<string, EntityEventAction>' };
  fields.upgrades = {
    description: 'Named handlers invoked when a saved entity upgrades to a newer version.',
    tsType: 'Record<string, EntityEventAction>',
  };
  await writeFile(file, JSON.stringify(schema));
}

/** Resolve references before sharing definitions between native document folders. */
function absoluteReferences(value: unknown, file: string): void {
  const node = object(value);

  if (Array.isArray(value)) {
    value.forEach(child => absoluteReferences(child, file));
  } else if (node) {
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#') && !/^[a-z]+:/i.test(node.$ref)) {
      const [reference, fragment] = node.$ref.split('#');

      node.$ref = pathToFileURL(path.resolve(path.dirname(file), reference)).href + (fragment ? '#' + fragment : '');
    }

    Object.values(node).forEach(child => absoluteReferences(child, file));
  }
}

/** Share client-resource fields and scripts while preserving document-specific properties. */
export async function normalizeEntities(source: string, folders: readonly ('entity' | 'attachables')[]): Promise<void> {
  if (!folders.length) {
    return;
  }

  const read = async (folder: string, name: string): Promise<SchemaNode | undefined> => {
    const file = path.join(source, 'schemas/rp', folder, name + '.schema.json');

    if (!(await exists(file))) {
      return;
    }

    const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;

    absoluteReferences(schema, file);

    return schema;
  };

  const entity = await read('entity', 'description');
  const attachable = await read('attachables', 'description');
  const entityProperties = object(entity?.properties) ?? {};
  const attachableProperties = object(attachable?.properties) ?? {};

  if (entity) {
    entityProperties.held_item_scale = { ...object(entityProperties.held_item_scale), type: 'number' };
  }

  for (const properties of [entityProperties, attachableProperties]) {
    for (const name of ['geometry', 'textures', 'materials', 'animations', 'particle_effects', 'particle_emitters', 'sound_effects']) {
      if (properties[name]) {
        properties[name] = { ...object(properties[name]), type: 'object', additionalProperties: { type: 'string' } };
        delete (properties[name] as SchemaNode).anyOf;
      }
    }

    if (properties.min_engine_version) {
      properties.min_engine_version = { ...object(properties.min_engine_version), type: 'string' };
    }
  }

  const common: SchemaNode = {};

  for (const [name, value] of Object.entries(entity ? entityProperties : attachableProperties)) {
    if (!entity || !attachable || Object.hasOwn(attachableProperties, name)) {
      common[name] = value;
    }
  }

  common.identifier = { ...object(common.identifier), description: 'The namespaced identifier of this client resource definition.' };

  const expression = { type: ['string', 'number'], tsType: 'MolangExpression' };
  const conditional = { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: expression }], tsType: 'ConditionalReference' };
  const entityScripts = await read('entity', 'scripts');
  const attachableScripts = await read('attachables', 'scripts');
  const scripts: SchemaNode = {
    ...object(attachableScripts?.properties),
    ...object(entityScripts?.properties),
    variables: { type: 'object', additionalProperties: { const: 'public' } },
    initialize: { type: 'array', items: expression },
    pre_animation: { anyOf: [expression, { type: 'array', items: expression }] },
    animate: { type: 'array', items: conditional },
  };

  for (const name of ['scale', 'parent_setup', 'hide_held_items', 'should_update_bones_and_effects_offscreen', 'should_update_effects_offscreen']) {
    scripts[name] = { ...object(scripts[name]), ...expression };
    delete (scripts[name] as SchemaNode).oneOf;
    delete (scripts[name] as SchemaNode).title;
  }

  for (const axis of ['x', 'y', 'z']) {
    const key = `scale[${axis}${axis.toUpperCase()}]`;
    const scale: SchemaNode = { ...object(scripts[key]), ...expression };

    delete scale.oneOf;
    delete scale.title;
    scripts[`scale${axis.toUpperCase()}`] = scale;
    scripts[`scale${axis}`] = scale;
    delete scripts[key];
  }

  common.scripts = { title: 'ClientResourceScripts', description: 'Initialization, animation playback and expression settings shared by client entities and attachables.', type: 'object', properties: scripts };
  common.render_controllers = { type: 'array', items: conditional };
  common.animation_controllers = { type: 'array', items: { type: 'object', additionalProperties: { type: 'string' } } };
  const shared = path.join(source, 'schemas/assets/client-resource/index.schema.json');

  await mkdir(path.dirname(shared), { recursive: true });
  await writeFile(shared, JSON.stringify({ title: 'ClientResourceDescription', description: 'Presentation bindings shared by client entities and attachables.', type: 'object', properties: common, required: ['identifier'] }));

  for (const folder of folders) {
    const description = folder === 'entity' ? entity : attachable;

    if (!description) {
      throw new Error('Missing native client-resource description: ' + folder);
    }

    const properties = Object.fromEntries(Object.entries(object(description.properties) ?? {}).filter(([key]) => !Object.hasOwn(common, key)));

    if (folder === 'attachables') {
      properties.item = { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: expression }] };
    }

    const file = path.join(source, 'schemas/rp', folder, 'description.schema.json');
    const allOf: SchemaNode[] = [{ tsType: 'ClientResourceDescription' }];

    if (Object.keys(properties).length) {
      allOf.push({ type: 'object', properties });
    }

    await writeFile(file, JSON.stringify({ title: folder === 'entity' ? 'ClientEntityDescription' : 'AttachableDescription', allOf }));
    const rootFile = path.join(source, 'schemas/rp', folder, 'index.schema.json');
    const root = JSON.parse(await readFile(rootFile, 'utf8')) as SchemaNode;
    const rootProperties = object(root.properties) ?? {};
    const key = folder === 'entity' ? 'minecraft:client_entity' : 'minecraft:attachable';
    const definition = object(rootProperties[key]);

    if (!definition) {
      throw new Error('Missing native client-resource definition: ' + key);
    }

    definition.required = ['description'];
    root.required = ['format_version', key];

    if (folder === 'entity') {
      delete rootProperties['minecraft:attachable'];
    }

    await writeFile(rootFile, JSON.stringify(root));
  }

  const catalogFile = path.join(source, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8')) as { schemas: { url: string }[] };

  catalog.schemas.push({ url: './schemas/assets/client-resource/index.schema.json' });
  await writeFile(catalogFile, JSON.stringify(catalog));
}
