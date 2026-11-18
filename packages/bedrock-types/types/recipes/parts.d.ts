import type { BrewingMixRecipeDocument } from './document';

/** Item stack used as a recipe result or a concrete ingredient. */
export interface RecipeItem {
  item: string;
  count?: number;
  data?: number;
}

/** A concrete item or an item tag, with an optional required amount. */
export type RecipeIngredient = RecipeItem | { tag: string; count?: number; data?: number };

/** Recipe-book discovery through an ingredient or a gameplay context. */
export type RecipeUnlock = RecipeIngredient | { context: string };

export interface BrewingContainerRecipeDocument {
  'format_version': BrewingMixRecipeDocument['format_version'];
  'minecraft:recipe_brewing_container': BrewingMixRecipeDocument['minecraft:recipe_brewing_mix'];
}
