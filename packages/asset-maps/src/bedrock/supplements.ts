import type { Catalog, Cube } from './types.ts';

const chestTypes = ['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:ender_chest'];

/** Minimal closed models for native block renderers that expose inventory textures but no geometry JSON. */
export function supplementBlockModels(catalog: Catalog): void {
  const id = 'geometry.bedrock_core.closed_chest';
  const sides = ['north', 'south', 'east', 'west', 'up', 'down'];
  // Native model Z reflects world Z; block texture slots use world directions.
  const uv: Cube['uv'] = Object.fromEntries(sides.map(side => [side, { uv: [0, 0], uv_size: [16, 16], material_instance: side === 'north' ? 'south' : side === 'south' ? 'north' : side }]));

  for (const type of chestTypes) {
    const block = catalog.blocks[type], native = block?.['minecraft:block'];

    if (!native || native.components?.['minecraft:geometry'] !== undefined || !block.textures) {
      continue;
    }

    catalog.models[id] ??= { geometry: { description: { identifier: id, texture_width: 16, texture_height: 16 }, bones: [{ name: 'chest', cubes: [{ origin: [-7, 0, -7], size: [14, 14, 14], uv }] }] },
      provenance: { kind: 'supplemental', warnings: ['Closed single-chest approximation using vanilla inventory textures; lid animation and joined chests require an adapter.'] } };
    const permutations = (Object.entries({ south: 0, east: 90, north: 180, west: -90 })).map(([direction, yaw]) => ({
      condition: `q.block_state('minecraft:cardinal_direction') == '${direction}'`, components: { 'minecraft:transformation': { rotation: [0, yaw, 0] } },
    }));

    catalog.blocks[type] = { ...block, 'minecraft:block': { ...native, components: { ...native.components, 'minecraft:geometry': id }, permutations: [...(native.permutations ?? []), ...permutations] } };
  }
}
