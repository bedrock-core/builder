import type { BlockStates } from '../compiler/types.ts';
import type { Geometry, GeometryContext, Resources } from './types.ts';

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const prefix = 'geometry.bedrock_core.asset_maps.';

export const namePart = (value: unknown): string => String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'default';

export function availableName(preferred: string, used: Set<string>): string {
  let name = preferred;

  for (let suffix = 2; used.has(name); suffix++) {
    name = preferred + '_' + suffix;
  }

  used.add(name);

  return name;
}

function sharedShapeName(blocks: string[], geometry: Geometry, states: BlockStates): string {
  const parts = blocks.map(block => block.split(':').at(-1)!.split('_'));

  if (parts.length === 1) {
    return parts[0].join('_');
  }

  const cubes = geometry.bones.flatMap(bone => bone.cubes ?? []);

  if (!cubes.length) {
    return 'empty';
  }

  let common = 0;

  while (common < Math.min(...parts.map(value => value.length)) && parts.every(value => value.at(-common - 1) === parts[0].at(-common - 1))) {
    common++;
  }

  if (common) {
    return parts[0].slice(-common).join('_');
  }

  const counts = new Map<string, number>();

  for (const tokens of parts) {
    for (let i = 1; i < tokens.length; i++) {
      const suffix = tokens.slice(i).join('_');

      counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
    }
  }

  const suffix = [...counts].filter(([, count]) => count > 1).sort(([a, x], [b, y]) => y - x || a.length - b.length || compare(a, b))[0]?.[0];

  if (suffix) {
    return suffix;
  }

  let start = 0;

  while (start < Math.min(...parts.map(value => value.length)) && parts.every(value => value[start] === parts[0][start])) {
    start++;
  }

  if (start && parts.some(value => value.length === start)) {
    return parts[0].slice(0, start).join('_');
  }

  if (Object.hasOwn(states, 'pillar_axis')) {
    return 'pillar';
  }

  if (Object.hasOwn(states, 'multi_face_direction_bits')) {
    return 'multiface';
  }

  if (cubes.length === 6 && cubes.every(cube => cube.size[0] === 16 && cube.size[1] === 16 && cube.size[2] === 0)) {
    return 'cube';
  }

  if (cubes.every(cube => JSON.stringify(cube.pivot) === JSON.stringify(cubes[0].pivot))) {
    return 'plane';
  }

  return 'plane_grid';
}

/** Name shared geometry for its block shape and the native states that select it. */
export function nameGeometries(files: Resources, contexts: Map<string, GeometryContext[]>): void {
  const geometries = new Map([...files].filter(([, document]) => document['minecraft:geometry']).map(([file, document]) => [document['minecraft:geometry']![0].description.identifier, { file, document }]));
  const owners = new Map<string, string>(), users = new Map<string, Set<string>>();

  for (const [block, rows] of contexts) {
    for (const { identifier } of rows) {
      if (geometries.has(identifier)) {
        if (!users.has(identifier)) {
          users.set(identifier, new Set());
        }

        users.get(identifier)!.add(block);

        if (!owners.has(identifier) || compare(block, owners.get(identifier)!) < 0) {
          owners.set(identifier, block);
        }
      }
    }
  }

  const candidates = [];

  for (const block of [...new Set(owners.values())].sort(compare)) {
    const rows = contexts.get(block)!;
    const blockParts = block.split(':').at(-1)!.split('_');

    const label = (key: string): string => {
      const name = namePart(key.replace(/^minecraft:/, ''));

      for (let i = 0; i < blockParts.length; i++) {
        const repeated = blockParts.slice(i).join('_') + '_';

        if (name.startsWith(repeated)) {
          return name.slice(repeated.length);
        }
      }

      return name;
    };

    let keys = Object.keys(rows[0].states).sort(compare);

    // Omit states whose removal still uniquely selects the same geometry.
    for (const key of [...keys].reverse()) {
      const remaining = keys.filter(value => value !== key), selected = new Map();

      if (rows.every((row) => {
        const state = JSON.stringify(remaining.map(key => row.states[key]));

        if (selected.has(state)) {
          return selected.get(state) === row.identifier;
        }

        selected.set(state, row.identifier);

        return true;
      })) { keys = remaining; }
    }

    const values = (entries: GeometryContext[], key: string): string[] => [...new Set(entries.map(row => JSON.stringify(row.states[key])))].sort(compare);

    const describe = (entries: GeometryContext[], omitComplete: boolean): string => {
      const parts = keys.flatMap((key) => {
        const selected = values(entries, key);

        if (omitComplete && selected.length === values(rows, key).length) {
          return [];
        }

        const name = label(key);

        return [{ name, stem: name.slice(0, Math.max(0, name.lastIndexOf('_'))), value: selected.map(value => namePart(JSON.parse(value))).join('_or_') }];
      });
      const seen = new Set();

      return parts.map(({ name, stem, value }) => {
        const short = stem && seen.has(stem) ? name.slice(stem.length + 1) : name;

        seen.add(stem);

        return short + '_' + value;
      }).join('__');
    };

    const variants = [...owners].filter(([, owner]) => owner === block).map(([identifier]) => {
      const selected = rows.filter(row => row.identifier === identifier);
      const representative = selected.toSorted((a, b) => compare(JSON.stringify(keys.map(key => a.states[key])), JSON.stringify(keys.map(key => b.states[key]))))[0];

      return { identifier, variant: describe(selected, true), representative: describe([representative], false), order: JSON.stringify(representative.states) };
    });
    const counts = new Map<string, number>();

    for (const { variant } of variants) {
      counts.set(variant, (counts.get(variant) ?? 0) + 1);
    }

    for (const value of variants) {
      const variant = counts.get(value.variant)! > 1 ? value.representative : value.variant;
      const shape = sharedShapeName([...users.get(value.identifier)!], geometries.get(value.identifier)!.document['minecraft:geometry']![0], rows.find(row => row.identifier === value.identifier)!.states);

      candidates.push({ identifier: value.identifier, path: namePart(block.split(':')[0]) + '/' + namePart(shape) + (variant ? '/' + variant : ''), order: block + '/' + value.order });
    }
  }

  const used = new Set<string>(), replacements = new Map<string, string>();

  for (const candidate of candidates.sort((a, b) => compare(a.path, b.path) || compare(a.order, b.order))) {
    const path = availableName(candidate.path, used);

    replacements.set(candidate.identifier, prefix + path.replaceAll('/', '.'));
    const { file, document } = geometries.get(candidate.identifier)!;

    files.delete(file);
    files.set('resource_pack/models/blocks/' + path + '.geo.json', document);
  }

  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return replacements.get(value) ?? value;
    }

    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        Reflect.set(value, key, replace(child));
      }
    }

    return value;
  };

  for (const document of files.values()) {
    replace(document);
  }
}
