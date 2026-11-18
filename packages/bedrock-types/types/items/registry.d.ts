import type { ItemComponentRegistry } from '../registries';

export type { ItemComponentRegistry } from '../registries';
export type ItemComponents = Partial<ItemComponentRegistry>;
export type ItemComponentId = Extract<keyof ItemComponentRegistry, string>;
export type ItemComponent<Id extends ItemComponentId> = ItemComponentRegistry[Id];
