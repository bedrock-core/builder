/**
 * Creative inventory categories, their groups, and the order of their items.
 * @see https://learn.microsoft.com/minecraft/creator/documents/craftingitemcatalogdocumentation
 */
export interface CraftingItemCatalogDocument {
  'format_version': string;
  'minecraft:crafting_items_catalog': {
    categories: [CraftingItemCatalogCategory, ...CraftingItemCatalogCategory[]];
  };
}

export interface CraftingItemCatalogCategory {
  category_name: 'construction' | 'equipment' | 'items' | 'nature';
  groups: CraftingItemCatalogGroup[];
}

export interface CraftingItemCatalogGroup {
  group_identifier?: { name: string; icon?: string };
  items: (string | { name: string })[];
}
