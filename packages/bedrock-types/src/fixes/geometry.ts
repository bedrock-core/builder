import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Normalize static geometry vectors, object arrays and locator forms. */
export async function normalizeGeometry(source: string): Promise<void> {
  const numericVectors = new Set([
    'origin',
    'size',
    'pivot',
    'rotation',
    'bind_pose_rotation',
    'visible_bounds_offset',
    'uv',
    'uv_size',
    'offset',
    'position',
    'local_pivot',
    'scale',
  ]);
  const objectArrays = new Set(['minecraft:geometry', 'bones', 'cubes', 'texture_meshes']);

  const fixVectors = (value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }

    const node = value as Record<string, unknown>;

    if (
      node.properties
      && typeof node.properties === 'object'
      && 'texture_width' in node.properties
      && 'visible_bounds_offset' in node.properties
    ) {
      Object.assign(node.properties, {
        visible_bounds_width: { type: 'number' },
        visible_bounds_height: { type: 'number' },
      });
    }

    if (node.properties && typeof node.properties === 'object' && 'name' in node.properties && 'cubes' in node.properties) {
      Object.assign(node.properties, {
        binding: { type: 'string', description: 'Molang expression selecting the bone attachment.' },
        inflate: { type: 'number', description: 'Bone inflation used by geometry versions before 1.16.0.' },
      });
    }

    if (node.properties && typeof node.properties === 'object' && 'description' in node.properties && 'bones' in node.properties) {
      Object.assign(node.properties, { item_display_transforms: { tsType: 'ItemDisplayTransforms' } });
    }

    if (node.properties && typeof node.properties === 'object' && 'uv' in node.properties && 'uv_size' in node.properties) {
      Object.assign(node.properties, { uv_rotation: { type: 'integer', enum: [0, 90, 180, 270] } });
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'locators' && child !== null && typeof child === 'object') {
        const field = child as Record<string, unknown>;
        const branches = Array.isArray(field.anyOf) ? field.anyOf : [];
        const detailed = branches.find(branch => branch.additionalProperties?.type === 'object')?.additionalProperties;

        if (detailed) {
          delete field.anyOf;
          field.type = 'object';
          field.additionalProperties = {
            anyOf: [
              {
                type: 'array',
                items: { type: 'number' },
                minItems: 3,
                maxItems: 3,
              },
              detailed,
            ],
          };
        }
      }

      if (numericVectors.has(key) && child !== null && typeof child === 'object') {
        const field = child as Record<string, unknown>;

        const branches = [field, ...(Array.isArray(field.anyOf) ? field.anyOf : [])];

        for (const branch of branches) {
          if (branch.type === 'array') {
            branch.items = { type: 'number' };
            branch.minItems = key === 'uv' || key === 'uv_size' ? 2 : 3;
            branch.maxItems = branch.minItems;
          }
        }
      }

      if (objectArrays.has(key) && child !== null && typeof child === 'object') {
        const field = child as Record<string, unknown>;
        const branches = Array.isArray(field.anyOf)
          ? field.anyOf.filter(branch => branch.type === 'array' && branch.items?.type === 'object')
          : [field];

        if (Array.isArray(field.anyOf)) {
          field.anyOf = branches;
        }

        if (key === 'cubes') {
          for (const branch of branches as {
            items: { properties: Record<string, unknown> };
          }[]) {
            branch.items.properties.inflate = { type: 'number' };
          }
        }
      }

      fixVectors(child);
    }
  };

  const geometryDirectory = path.join(source, 'schemas/rp/models');

  for (const file of await readdir(geometryDirectory)) {
    if (!file.endsWith('.json')) {
      continue;
    }

    const filename = path.join(geometryDirectory, file);
    const geometry = JSON.parse(await readFile(filename, 'utf8'));

    fixVectors(geometry);

    if (file === 'index.schema.json') {
      geometry.allOf = [{ tsType: 'Partial<Record<`geometry.${string}`, LegacyModelGeometry>>' }];
    }

    await writeFile(filename, JSON.stringify(geometry));
  }
}
