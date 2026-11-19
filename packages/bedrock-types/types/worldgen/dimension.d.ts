/**
 * Behavior-pack definition for a custom dimension or a supported vanilla override.
 * @see https://learn.microsoft.com/minecraft/creator/documents/scripting/custom-dimension-api-tutorial
 */
export interface DimensionDocument {
  'format_version': string;
  'minecraft:dimension': {
    description: { identifier: string };
    components: DimensionComponents;
  };
}

export interface DimensionComponents {
  /** Required when defining a new dimension. */
  'minecraft:generation'?: { generator_type: 'void' };
  'minecraft:dimension_height'?: { min_y: number; height_range: number };
  'minecraft:default_biome'?: { biome: string };
  /** Clouds render at this Y coordinate when the component is present. */
  'minecraft:clouds'?: { height: number };
}
