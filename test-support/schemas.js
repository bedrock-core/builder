import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A small local catalog for testing declaration generation without registry access. */
export async function seedSchemas(project, version = '1.0.0-test') {
  const cache = path.join(project, '.bedrock-core/cache/generator');
  const root = path.join(cache, version);
  const document = (title, key, components) => ({
    title, type: 'object', properties: {
      format_version: { type: 'string' },
      [key]: { type: 'object', properties: {
        description: { type: 'object' },
        components: { type: 'object', properties: components },
      } },
    },
  });
  const schemas = {
    'bp/entities': document('Entity Behavior Document', 'minecraft:entity', {
      'minecraft:health': { type: 'object', properties: { value: { type: 'number' }, max: { type: 'number' } } },
      'minecraft:physics': { title: 'Physics', description: 'Controls entity physics.', type: 'object' },
      'missing:component': { title: 'Missing Component', description: 'Uses a schema not supplied by this package.', $ref: '../../common/missing.schema.json' },
    }),
    'bp/blocks': document('Block Behavior Document', 'minecraft:block', {
      'minecraft:map_color': { title: 'Name', description: 'Sets the color on maps.', type: 'object', minLength: 1 },
      'minecraft:light_emission': { title: 'Light', description: 'Controls the emitted light level.', type: 'number' },
      'example:mode': { title: 'Block Mode', type: 'string', enum: ['solid', 'transparent'] },
    }),
    'bp/animations': { title: 'Animation Document', type: 'object', properties: { format_version: { type: 'string' } } },
    'rp/entity': { title: 'Entity Resource Document', type: 'object', properties: { format_version: { type: 'string' } } },
  };

  await mkdir(path.join(root, 'types'), { recursive: true });

  for (const [key, schema] of Object.entries(schemas)) {
    const file = path.join(root, 'schemas', key, 'index.schema.json');

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(schema));
  }

  await writeFile(path.join(root, 'catalog.json'), JSON.stringify({ schemas: Object.keys(schemas).map(key => ({ url: `./schemas/${key}/index.schema.json` })) }));
  await writeFile(path.join(root, '.complete'), version);
  await writeFile(path.join(cache, 'registry.json.cache'), JSON.stringify({
    'dist-tags': { latest: version },
    'versions': { [version]: { dist: { tarball: 'https://registry.npmjs.org/unused-fixture' } } },
  }));

  return { root, version };
}
