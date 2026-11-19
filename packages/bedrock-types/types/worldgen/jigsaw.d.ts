import type { FilterGroup } from '../common/filters';

export type JigsawVerticalAnchor
  = { absolute: number }
    | { above_bottom: number }
    | { below_top: number }
    | { from_sea: number };

export type JigsawStartHeight
  = { type: 'constant'; value: JigsawVerticalAnchor }
    | { type: 'uniform'; min: JigsawVerticalAnchor; max: JigsawVerticalAnchor };

type JigsawPoolRedirect
  = { type: 'direct'; alias: string; target: string }
    | { type: 'random'; alias: string; targets: { data: string; weight: number }[] };

export type JigsawPoolAlias
  = JigsawPoolRedirect
    | { type: 'random_group'; groups: { data: JigsawPoolRedirect[]; weight: number }[] };

/** @see https://learn.microsoft.com/minecraft/creator/reference/content/worldgenreference/examples/jigsawjigsawstructurejson */
export interface JigsawDocument {
  'format_version': string;
  'minecraft:jigsaw': JigsawStructure;
}

export interface JigsawStructure {
  description: { identifier: string };
  start_pool: string;
  start_height: JigsawStartHeight;
  max_depth: number;
  step: JigsawGenerationStep;
  biome_filters?: FilterGroup;
  start_jigsaw_name?: string;
  heightmap_projection?: 'none' | 'world_surface' | 'ocean_floor';
  terrain_adaptation?: 'none' | 'beard_thin' | 'beard_box' | 'bury' | 'encapsulate';
  dimension_padding?: number | { top?: number; bottom?: number };
  max_distance_from_center?: number | { horizontal: number; vertical?: number };
  pool_aliases?: JigsawPoolAlias[];
  on_placed?: string;
  liquid_settings?: 'apply_waterlogging' | 'ignore_waterlogging';
}

export type JigsawGenerationStep
  = 'raw_generation'
    | 'lakes'
    | 'local_modifications'
    | 'underground_structures'
    | 'surface_structures'
    | 'strongholds'
    | 'underground_ores'
    | 'underground_decoration'
    | 'fluid_springs'
    | 'vegetal_decoration'
    | 'top_layer_modification';
