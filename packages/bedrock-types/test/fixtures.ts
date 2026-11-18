import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export async function fixture(t: TestContext): Promise<{ root: string; schemaRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'bedrock-types-test-'));
  const schemaRoot = path.join(root, 'input');

  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('bedrock-types-test-'));
    await rm(root, { recursive: true, force: true });
  });

  const schemas = {
    'rp/entity/index.schema.json': {
      title: 'Upstream title is not the public name',
      type: 'object',
      properties: {
        'format_version': { type: 'string' },
        'minecraft:client_entity': { type: 'object', properties: { description: { $ref: './description.schema.json' } } },
      },
    },
    'rp/entity/description.schema.json': {
      type: 'object',
      properties: { identifier: { type: 'string' }, textures: { type: 'object' }, geometry: { type: 'object' } },
    },
    'rp/entity/scripts.schema.json': { type: 'object', properties: {} },
    'rp/models/index.schema.json': {
      title: 'Model legacy title',
      type: 'object',
      properties: {
        'format_version': { type: 'string' },
        'minecraft:geometry': {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bones: {
                type: 'array',
                items: { type: 'object', properties: { name: { type: 'string' }, pivot: { type: 'array', items: { type: 'string' } } } },
              },
            },
          },
        },
      },
    },
  };

  await mkdir(schemaRoot);
  await cp(new URL('../types/common', import.meta.url), path.join(root, 'types/common'), { recursive: true });
  await writeFile(path.join(schemaRoot, 'package.json'), JSON.stringify({ name: '@minecraft/bedrock-schemas', version: '1.0.0-test' }));
  await writeFile(path.join(schemaRoot, 'LICENSE'), 'Schema fixture license');
  await writeFile(
    path.join(schemaRoot, 'catalog.json'),
    JSON.stringify({ schemas: ['rp/entity', 'rp/models'].map(key => ({ url: './schemas/' + key + '/index.schema.json' })) }),
  );

  for (const [name, schema] of Object.entries(schemas)) {
    const file = path.join(schemaRoot, 'schemas', name);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(schema));
  }

  return { root, schemaRoot };
}
