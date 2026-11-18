import type { BlockDocument } from './document';
import type { BlockComponents } from './registry';

export type BlockDefinition = BlockDocument['minecraft:block'];
export type BlockDescription = BlockDefinition['description'];
export type BlockStates = NonNullable<BlockDescription['states']>;
export type BlockPermutation = NonNullable<BlockDefinition['permutations']>[number];
export type BlockGeometry = NonNullable<BlockComponents['minecraft:geometry']>;
export type BlockMaterialInstance = Exclude<NonNullable<BlockComponents['minecraft:material_instances']>[string], string>;
export type BlockTransformation = NonNullable<BlockComponents['minecraft:transformation']>;
export type BlockCollisionBox = NonNullable<BlockComponents['minecraft:collision_box']>;
