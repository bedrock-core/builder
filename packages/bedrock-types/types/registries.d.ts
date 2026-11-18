import type { NativeBlockComponents } from './blocks/components';
import type { NativeItemComponents } from './items/components';
import type { NativeEntityComponents } from './entities/components';

type RegistryValues<Variants> = {
  [Key in Variants extends unknown ? keyof Variants : never]-?: Variants extends unknown
    ? Key extends keyof Variants ? Exclude<Variants[Key], undefined> : never
    : never;
};

/** Native block component payloads, extended by declaration merging for additional identifiers. */
export interface BlockComponentRegistry extends Required<NativeBlockComponents> {}

/** Native item component payloads across the supported format versions. */
export interface ItemComponentRegistry extends RegistryValues<NativeItemComponents> {}

/** Entity behavior component payloads, shared by base components and component groups. */
export interface EntityComponentRegistry extends Required<NativeEntityComponents> {}

/** Component families available to generic document and registry tooling. */
export interface ComponentRegistries {
  block: BlockComponentRegistry;
  item: ItemComponentRegistry;
  entity: EntityComponentRegistry;
}

export type ComponentKind = keyof ComponentRegistries;
export type ComponentId<Kind extends ComponentKind> = Extract<keyof ComponentRegistries[Kind], string>;
export type Component<Kind extends ComponentKind, Id extends ComponentId<Kind>> = ComponentRegistries[Kind][Id];
export type Components<Kind extends ComponentKind> = Partial<ComponentRegistries[Kind]>;
