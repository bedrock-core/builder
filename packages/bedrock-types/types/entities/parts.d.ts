import type { EntityDocument } from './behavior';
import type { ClientEntityDocument } from './client';

export type EntityDefinition = EntityDocument['minecraft:entity'];
export type EntityComponentGroups = NonNullable<EntityDefinition['component_groups']>;
export type ClientEntityDefinition = NonNullable<ClientEntityDocument['minecraft:client_entity']>;
export type ClientEntityDescription = NonNullable<ClientEntityDefinition['description']>;
export type ClientEntityScripts = NonNullable<ClientEntityDescription['scripts']>;
