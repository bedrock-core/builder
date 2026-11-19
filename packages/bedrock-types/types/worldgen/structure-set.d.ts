/** @see https://learn.microsoft.com/minecraft/creator/reference/content/worldgenreference/examples/jigsawstructuresets */
export interface StructureSetDocument {
  'format_version': string;
  'minecraft:structure_set': {
    description: { identifier: string };
    placement: StructureSetPlacement;
    structures: [StructureSetEntry, ...StructureSetEntry[]];
  };
}

export interface StructureSetEntry {
  structure: string;
  weight: number;
}

export interface StructureSetPlacement {
  type: 'minecraft:random_spread';
  salt: number;
  /** Grid cell size in chunks. */
  spacing: number;
  /** Padding inside a grid cell, smaller than spacing. */
  separation: number;
  spread_type?: 'linear' | 'triangular';
}
