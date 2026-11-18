import type { MinecraftItemV1260Components } from '../internal/upstream/bp/items/components/MinecraftItemV1260';
import type { MinecraftItemV12190Components } from '../internal/upstream/bp/items/components/MinecraftItemV12190';
import type MinecraftKineticWeapon from '../internal/upstream/bp/items/components/MinecraftKineticWeapon';
import type MinecraftPiercingWeapon from '../internal/upstream/bp/items/components/MinecraftPiercingWeapon';
import type { MolangExpression } from '../common/primitives';

/** Short names from the resource pack's item texture atlas. */
export type ItemIcon = string | { textures: Record<string, string> };

export interface ItemRepairEntry {
  items: (string | { tags: string })[];
  repair_amount?: MolangExpression;
}

type ItemReach = { min?: number; max?: number };
type ItemWeaponWithReach<Component> = Omit<Component, 'reach' | 'creative_reach'> & {
  reach?: ItemReach;
  creative_reach?: ItemReach;
};

interface CorrectedItemComponents {
  'minecraft:icon'?: ItemIcon;
  'minecraft:display_name'?: string | { value: string };
  'minecraft:damage'?: number | { value: number };
  'minecraft:hand_equipped'?: boolean | { value: boolean };
  'minecraft:use_animation'?: string | { value: string };
  'minecraft:fuel'?: number | { duration: number };
  'minecraft:fire_resistant'?: { value?: boolean };
  'minecraft:swing_duration'?: number | { value: number };
  'minecraft:piercing_weapon'?: ItemWeaponWithReach<MinecraftPiercingWeapon>;
  'minecraft:kinetic_weapon'?: ItemWeaponWithReach<MinecraftKineticWeapon>;
  'minecraft:swing_sounds'?: {
    attack_miss?: string;
    attack_hit?: string;
    attack_critical_hit?: string;
  };
  'minecraft:compostable'?: { composting_chance: number };
  'minecraft:storage_item'?: {
    max_slots?: number;
    allow_nested_storage_items?: boolean;
    allowed_items?: string[];
    banned_items?: string[];
  };
  'minecraft:storage_weight_limit'?: { max_weight_limit?: number };
  'minecraft:storage_weight_modifier'?: { weight_in_storage_item?: number };
  'minecraft:bundle_interaction'?: { num_viewable_slots?: number };
}

type ItemComponentsWithSdkFields<Components extends {
  'minecraft:repairable'?: object;
  'minecraft:use_modifiers'?: object;
  'minecraft:block_placer'?: object;
}> = Omit<Components, keyof CorrectedItemComponents | 'minecraft:repairable' | 'minecraft:use_modifiers' | 'minecraft:block_placer'>
  & CorrectedItemComponents & {
    'minecraft:repairable'?: Omit<NonNullable<Components['minecraft:repairable']>, 'repair_items'> & {
      repair_items?: (string | ItemRepairEntry)[];
    };
    'minecraft:use_modifiers'?: Omit<NonNullable<Components['minecraft:use_modifiers']>, 'start_sound'> & {
      start_sound?: string;
    };
    'minecraft:block_placer'?: Omit<NonNullable<Components['minecraft:block_placer']>, 'block'> & {
      block?: string | { name: string; states?: Record<string, string | number | boolean> };
    };
  };

export type NativeItemComponents
  = ItemComponentsWithSdkFields<MinecraftItemV1260Components> | ItemComponentsWithSdkFields<MinecraftItemV12190Components>;
