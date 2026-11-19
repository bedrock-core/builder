/** @see https://learn.microsoft.com/minecraft/creator/reference/content/worldgenreference/examples/jigsawprocessors */
export interface ProcessorListDocument {
  'format_version': string;
  'minecraft:processor_list': {
    description: { identifier: string };
    processors: StructureProcessor[];
  };
}

type UncappedProcessor
  = { processor_type: 'minecraft:block_ignore'; blocks: string[] }
    | { processor_type: 'minecraft:protected_blocks'; value: string }
    | { processor_type: 'minecraft:rule'; rules: StructureProcessorRule[] };

export type StructureProcessor
  = UncappedProcessor
    | { processor_type: 'minecraft:capped'; limit: ProcessorLimit; delegate: UncappedProcessor };

export type ProcessorLimit
  = number
    | { type: 'constant'; value: number }
    | { type: 'uniform'; min_inclusive: number; max_inclusive: number };

export type StructureProcessorBlock = string | {
  name?: string;
  states?: Record<string, boolean | number | string>;
  tags?: string;
};

type AlwaysTruePredicate = { predicate_type: 'minecraft:always_true' };

export type StructureBlockPredicate
  = AlwaysTruePredicate
    | { predicate_type: 'minecraft:block_match'; block: string }
    | { predicate_type: 'minecraft:random_block_match'; block: string; probability: number }
    | { predicate_type: 'minecraft:tag_match'; tag: string }
    | { predicate_type: 'minecraft:blockstate_match'; block_state: StructureProcessorBlock }
    | { predicate_type: 'minecraft:random_blockstate_match'; block_state: StructureProcessorBlock; probability: number };

export type StructurePositionPredicate = AlwaysTruePredicate | {
  predicate_type: 'minecraft:axis_aligned_linear_pos';
  axis?: 'x' | 'y' | 'z';
  min_dist?: number;
  max_dist?: number;
  min_chance?: number;
  max_chance?: number;
};

export interface StructureProcessorRule {
  output_state: StructureProcessorBlock;
  input_predicate?: StructureBlockPredicate;
  location_predicate?: StructureBlockPredicate;
  position_predicate?: StructurePositionPredicate;
  block_entity_modifier?: { type: 'minecraft:passthrough' } | { type: 'minecraft:append_loot'; loot_table: string };
}
