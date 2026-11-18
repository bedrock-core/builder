type ItemWrapper = { 'minecraft:item': { components?: object } };
type EntityWrapper = { 'minecraft:entity': { events?: object } };
type SoundWrapper = { sound_definitions: Record<string, { sounds?: unknown[] }> };

type LegacySaturation = 'poor' | 'low' | 'normal' | 'good' | 'max' | 'supernatural';
type ComponentValue<Components, Id> = Id extends keyof Components ? NonNullable<Components[Id]> : never;
type LegacyFood<Components> = Omit<ComponentValue<Components, 'minecraft:food'>, 'saturation_modifier'> & {
  saturation_modifier?: number | LegacySaturation;
  is_meat?: boolean;
  effects?: { name: string; chance?: number; duration?: number; amplifier?: number }[];
  remove_effects?: string[];
  on_use_action?: string;
  on_use_range?: [number, number, number];
  cooldown_type?: string;
  cooldown_time?: number;
};

type LegacyItemComponents<Components> = Omit<Components, 'minecraft:food' | 'minecraft:icon'> & {
  'minecraft:food'?: LegacyFood<Components>;
  'minecraft:icon'?: ComponentValue<Components, 'minecraft:icon'> | { texture: string };
  'minecraft:use_duration'?: number;
  'minecraft:seed'?: {
    crop_result: string;
    plant_at?: string | string[];
    plant_at_any_solid_surface?: boolean;
    plant_at_face?: string;
  };
  'minecraft:block'?: string;
  'minecraft:camera'?: {
    black_bars_duration?: number;
    black_bars_screen_ratio?: number;
    shutter_duration?: number;
    picture_duration?: number;
    slide_away_duration?: number;
  };
  'minecraft:foil'?: boolean;
  'minecraft:max_damage'?: number;
};

type LegacyItemDocument<Document extends ItemWrapper> = Omit<Document, 'minecraft:item'> & {
  'minecraft:item': Omit<Document['minecraft:item'], 'components'> & {
    components?: LegacyItemComponents<NonNullable<Document['minecraft:item']['components']>>;
  };
};

interface LegacyClientBiomes {
  biomes: Record<string, {
    water_surface_color?: string;
    water_surface_transparency?: number;
    fog_identifier?: string;
    remove_all_prior_fog?: boolean;
    inherit_from_prior_fog?: boolean;
  }>;
}

type VanillaEntityDocument<Document extends EntityWrapper> = Omit<Document, 'minecraft:entity'> & {
  'minecraft:entity': Omit<Document['minecraft:entity'], 'events'> & {
    events?: Document['minecraft:entity']['events'] | null;
  };
};

type VanillaSoundEntry<Entry> = Entry extends object ? Entry & { allow_concurrent_streaming?: boolean } : Entry;
type VanillaSoundDefinition<Definition extends { sounds?: unknown[] }>
  = Omit<Definition, 'sounds' | 'min_distance' | 'max_distance'> & {
    sounds?: VanillaSoundEntry<NonNullable<Definition['sounds']>[number]>[];
    min_distance?: number | null;
    max_distance?: number | null;
    pitch?: number;
    volume?: number;
    __use_legacy_max_distance?: 'true' | 'false';
  };

type VanillaSoundDocument<Document extends SoundWrapper> = Omit<Document, 'sound_definitions'> & {
  sound_definitions: Record<string, VanillaSoundDefinition<Document['sound_definitions'][string]>>;
};

/** Extra document contracts used only by the vanilla audit. */
export interface CompatibilityDocuments<Published extends {
  'bp/items': ItemWrapper;
  'bp/entities': EntityWrapper;
  'rp/sounds': SoundWrapper;
}> {
  'legacy/bp/items': LegacyItemDocument<Published['bp/items']>;
  'legacy/rp/biomes_client': LegacyClientBiomes;
  'vanilla/bp/entities': VanillaEntityDocument<Published['bp/entities']>;
  'vanilla/rp/sounds': VanillaSoundDocument<Published['rp/sounds']>;
}
