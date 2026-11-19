import type { BoundedArray } from '../common/primitives';
import type { BlockDocument } from './document';
import type { BlockComponents } from './registry';

export type BlockDefinition = BlockDocument['minecraft:block'];
export type BlockDescription = BlockDefinition['description'];
export type BlockPermutation = NonNullable<BlockDefinition['permutations']>[number];
export type BlockGeometry = NonNullable<BlockComponents['minecraft:geometry']>;
export type BlockMaterialInstance = Exclude<NonNullable<BlockComponents['minecraft:material_instances']>[string], string>;
export type BlockTransformation = NonNullable<BlockComponents['minecraft:transformation']>;
export type BlockCollisionBox = NonNullable<BlockComponents['minecraft:collision_box']>;

/** Inclusive integer bounds. A block state supports up to 16 distinct values. */
export interface BlockStateRange {
  values: { min: number; max: number };
}

export type BlockStateDefinition
  = BoundedArray<boolean, 1, 16>
    | BoundedArray<number, 1, 16>
    | BoundedArray<string, 1, 16>
    | BlockStateRange;

/**
 * State definitions keyed by their namespaced identifiers.
 * @see https://learn.microsoft.com/minecraft/creator/reference/content/blockreference/examples/blockstatesandpermutations
 */
export type BlockStates = Record<`${string}:${string}`, BlockStateDefinition>;
