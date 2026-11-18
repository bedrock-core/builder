import type { EntityComponentRegistry } from '../registries';

export type { EntityComponentRegistry } from '../registries';
export type EntityComponents = Partial<EntityComponentRegistry>;
export type EntityComponentId = Extract<keyof EntityComponentRegistry, string>;
export type EntityComponent<Id extends EntityComponentId> = EntityComponentRegistry[Id];
