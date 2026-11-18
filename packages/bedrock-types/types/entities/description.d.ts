import type { ConditionalReference, MolangExpression, Vector2 } from '../common/primitives';

interface EntityPropertyOptions {
  client_sync?: boolean;
}

/** A persisted property declared on the behavior entity. Defaults may use Molang. */
export type EntityProperty = EntityPropertyOptions & (
  | { type: 'bool'; default: boolean | string }
  | { type: 'enum'; values: string[]; default: string }
  | { type: 'int' | 'float'; range: Vector2; default: MolangExpression }
);

export interface EntityUpgradeStep {
  /** Positive version reached by this step. Use each version from 1 to the current version once. */
  upgrade_to: number;
  /** Key in the entity's upgrades section. */
  name: string;
}

export interface EntityVersion {
  upgrades: EntityUpgradeStep[];
}

export interface EntityBehaviorScripts {
  animate?: ConditionalReference[];
}

/** Registration, properties and server animation bindings for a behavior entity. */
export interface EntityDescription {
  identifier: string;
  runtime_identifier?: string;
  is_spawnable?: boolean;
  is_summonable?: boolean;
  is_experimental?: boolean;
  spawn_category?: 'monster' | 'creature' | 'ambient' | 'axolotls' | 'underground_water_creature' | 'water_creature' | 'water_ambient' | 'misc';
  properties?: Record<string, EntityProperty>;
  animations?: Record<string, string>;
  scripts?: EntityBehaviorScripts;
  /** Requires format_version 1.26.20 or later and the Upcoming Creator Features experiment. */
  entity_version?: EntityVersion;
}
