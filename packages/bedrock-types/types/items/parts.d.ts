import type { ItemDocument } from './document';

export type ItemDefinition = ItemDocument['minecraft:item'];
export type ItemDescription = NonNullable<ItemDefinition['description']>;
