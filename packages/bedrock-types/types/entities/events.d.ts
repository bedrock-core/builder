import type { FilterGroup } from '../common/filters';
import type { MolangExpression } from '../common/primitives';

interface EntityEventComponentGroups {
  component_groups?: string[];
}

export type EntityEventTrigger = string | {
  event: string;
  target?: 'self' | 'other' | 'player' | 'target' | 'baby' | 'parent' | 'block';
};

/** Actions shared by regular events and entity upgrade handlers. */
export interface EntityEventAction {
  filters?: FilterGroup;
  add?: EntityEventComponentGroups;
  remove?: EntityEventComponentGroups;
  sequence?: EntityEventAction[];
  randomize?: (EntityEventAction & { weight?: number })[];
  first_valid?: EntityEventAction[];
  /** Triggers a named response. Upgrade handlers can trigger other upgrade handlers. */
  trigger?: EntityEventTrigger;
  set_property?: Record<string, MolangExpression | boolean>;
  queue_command?: { command: string | string[]; target?: 'self' };
  play_sound?: { sound: string };
  emit_particle?: { particle: string };
  emit_vibration?: { vibration: 'entity_interact' | 'entity_act' | 'entity_die' };
  reset_target?: Record<string, never>;
  stop_movement?: { stop_vertical_movement?: boolean; stop_horizontal_movement?: boolean };
  set_home_position?: Record<string, never>;
  execute_event_on_home_block?: { event: string };
  drop_item?: { slot: string };
}
