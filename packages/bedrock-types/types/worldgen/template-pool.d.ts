import type { StructureProcessor } from './processor-list';

/** @see https://learn.microsoft.com/minecraft/creator/reference/content/worldgenreference/examples/jigsawtemplatepools */
export interface TemplatePoolDocument {
  'format_version': string;
  'minecraft:template_pool': {
    description: { identifier: string };
    elements: [WeightedTemplatePoolElement, ...WeightedTemplatePoolElement[]];
    fallback?: string;
  };
}

export interface WeightedTemplatePoolElement {
  element: TemplatePoolElement;
  weight?: number;
}

type TemplateProjection = 'rigid' | 'terrain_matching';

export type TemplatePoolElement
  = { element_type: 'minecraft:empty_pool_element' }
    | { element_type: 'minecraft:feature_pool_element'; feature: string; projection?: TemplateProjection }
    | { element_type: 'minecraft:list_pool_element'; elements: TemplatePoolElement[]; projection?: TemplateProjection }
    | {
      element_type: 'minecraft:single_pool_element' | 'minecraft:legacy_single_pool_element';
      location: string;
      processors?: string | { processors: StructureProcessor[] };
      projection?: TemplateProjection;
    };
