import type { BlockComponentRegistry } from '../registries';

export type { BlockComponentRegistry } from '../registries';
export type BlockComponents = Partial<BlockComponentRegistry>;
export type BlockComponentId = Extract<keyof BlockComponentRegistry, string>;
export type BlockComponent<Id extends BlockComponentId> = BlockComponentRegistry[Id];
