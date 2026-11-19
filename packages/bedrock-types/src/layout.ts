/** Public declarations for documents without roots in the pinned Mojang schema catalog. */
export const authoredDocuments = {
  'bp/cameras/presets': { file: 'cameras/preset', name: 'CameraPresetDocument' },
  'bp/dimensions': { file: 'worldgen/dimension', name: 'DimensionDocument' },
  'bp/item_catalog/crafting_item_catalog': { file: 'items/catalog', name: 'CraftingItemCatalogDocument' },
  'bp/sounds/server_sound_definitions': { file: 'sounds/server-definitions', name: 'ServerSoundDefinitionsDocument' },
  'bp/worldgen/jigsaw_structures': { file: 'worldgen/jigsaw', name: 'JigsawDocument' },
  'bp/worldgen/processors': { file: 'worldgen/processor-list', name: 'ProcessorListDocument' },
  'bp/worldgen/structure_sets': { file: 'worldgen/structure-set', name: 'StructureSetDocument' },
  'bp/worldgen/template_pools': { file: 'worldgen/template-pool', name: 'TemplatePoolDocument' },
} as const;

/** Stable public document names and files, independent of upstream schema titles. */
export const documents: Readonly<Record<string, { file: string; name: string; names?: readonly string[] }>> = {
  ...authoredDocuments,
  'bp/entities': { file: 'entities/behavior', name: 'EntityDocument' },
  'bp/blocks': { file: 'blocks/document', name: 'BlockDocument' },
  'bp/items': { file: 'items/document', name: 'ItemDocument' },
  'bp/biomes': { file: 'worldgen/biome', name: 'BiomeDocument' },
  'rp/biomes': { file: 'worldgen/client-biome', name: 'ClientBiomeDocument' },
  'bp/features': { file: 'worldgen/feature', name: 'FeatureDocument' },
  'bp/feature_rules': { file: 'worldgen/feature-rule', name: 'FeatureRuleDocument' },
  'bp/loot_tables': { file: 'loot/table', name: 'LootTableDocument', names: ['LootTableDocument', 'LootFunction'] },
  'bp/recipes': { file: 'recipes/document', name: 'RecipeDocument' },
  'bp/spawn_rules': { file: 'entities/spawn-rules', name: 'SpawnRuleDocument' },
  'bp/trading': {
    file: 'loot/trading',
    name: 'TradingDocument',
    names: ['TradingDocument', 'TradeTier', 'TradeGroup', 'Trade', 'TradeEntry', 'TradeItem', 'TradeQuantity'],
  },
  'bp/animations': { file: 'animations/document', name: 'AnimationDocument' },
  'bp/animation_controllers': { file: 'animations/controllers', name: 'AnimationControllerDocument' },
  'bp/voxel_shapes': { file: 'blocks/voxel-shape', name: 'VoxelShapeDocument' },
  'rp/entity': { file: 'entities/client', name: 'ClientEntityDocument' },
  'rp/models': { file: 'models/geometry', name: 'GeometryDocument' },
  'rp/fogs': { file: 'fogs/document', name: 'FogDocument' },
  'rp/attachables': { file: 'attachables/document', name: 'AttachableDocument' },
  'rp/render_controllers': { file: 'render-controllers/document', name: 'RenderControllerDocument' },
  'rp/sounds': { file: 'sounds/definitions', name: 'SoundDefinitionsDocument' },
  'rp/sounds/events': { file: 'sounds/events', name: 'SoundEventsDocument' },
  'rp/textures/blocks_resource': { file: 'textures/blocks', name: 'BlockTexturesDocument', names: ['BlockTexturesDocument', 'BlockResourceDefinition'] },
  'rp/textures/terrain_texture': { file: 'textures/terrain', name: 'TerrainTexturesDocument' },
  'rp/textures/item_texture': { file: 'textures/items', name: 'ItemTexturesDocument' },
  'rp/textures/texture_list': { file: 'textures/list', name: 'TextureListDocument' },
  'rp/textures/flipbook_textures': { file: 'textures/flipbook', name: 'FlipbookTextureDocument', names: ['FlipbookTextureDocument', 'FlipbookTexture'] },
  'rp/block_culling': { file: 'blocks/culling', name: 'BlockCullingDocument' },
  'rp/textures/texture_set': { file: 'textures/texture-set', name: 'TextureSetDocument', names: ['TextureSetDocument', 'TextureSet'] },
  'rp/sounds/music_definitions': { file: 'sounds/music', name: 'MusicDefinitionsDocument' },
  'rp/deferred_rendering/lighting': { file: 'deferred/lighting', name: 'LightingDocument' },
  'rp/deferred_rendering/color_grading': { file: 'deferred/color-grading', name: 'ColorGradingDocument' },
  'rp/deferred_rendering/atmospherics': { file: 'deferred/atmospherics', name: 'AtmosphericsDocument' },
  'rp/deferred_rendering/pbr': { file: 'deferred/pbr', name: 'PBRDocument' },
  'rp/deferred_rendering/point_lights': { file: 'deferred/point-lights', name: 'PointLightsDocument' },
  'rp/deferred_rendering/shadows': { file: 'deferred/shadows', name: 'ShadowsDocument' },
  'rp/deferred_rendering/water': { file: 'deferred/water', name: 'WaterDocument' },
  'assets/block-components': { file: 'blocks/components', name: 'NativeBlockComponents' },
  'assets/entity-components': { file: 'entities/components', name: 'NativeEntityComponents' },
  'assets/client-resource': { file: 'common/client-resource', name: 'ClientResourceDescription', names: ['ClientResourceDescription', 'ClientResourceScripts'] },
};

export const documentAliases: Readonly<Record<string, string>> = {
  'rp/animations': 'bp/animations',
  'rp/animation_controllers': 'bp/animation_controllers',
};

export const groups = [...new Set(Object.values(documents).map(document => document.file.split('/')[0]))].sort();

export function categoryKey(url: string): string {
  return url
    .replace(/^\.?\//, '')
    .replace(/^schemas\//, '')
    .replace(/\/index\.schema\.json$/, '')
    .replace(/\.schema\.json$/, '');
}
