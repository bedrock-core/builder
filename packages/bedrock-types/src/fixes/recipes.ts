import { declarationEdits } from '../schema/patch.ts';

/** Correct shared recipe inputs, results and unlocks while preserving upstream document fields. */
export function normalizeRecipes(text: string, name: string): string {
  const { members, replace, finish } = declarationEdits(text);
  const prefix = name + 'Minecraft' + name;
  let imports = '';

  if (name === 'RecipeShaped' || name === 'RecipeShapeless') {
    members(prefix, {
      [name === 'RecipeShaped' ? 'key' : 'ingredients']: name === 'RecipeShaped' ? 'Record<string, RecipeIngredient>' : 'RecipeIngredient[]',
      result: 'RecipeItem | RecipeItem[]',
      unlock: 'RecipeUnlock | RecipeUnlock[]',
    });

    for (const suffix of name === 'RecipeShaped' ? ['Key', 'KeyAZaz', 'Result', 'Unlock'] : ['Ingredients', 'Result', 'Unlock']) {
      replace(prefix + suffix, '');
    }

    imports = 'import type { RecipeIngredient, RecipeItem, RecipeUnlock } from \'../../../../recipes/parts\';\n';
  } else if (name === 'RecipeFurnace') {
    members(prefix, { input: 'string | RecipeIngredient', unlock: 'RecipeUnlock | RecipeUnlock[]', priority: 'number' });
    imports = 'import type { RecipeIngredient, RecipeUnlock } from \'../../../../recipes/parts\';\n';
  } else if (name === 'RecipeSmithingTrim') {
    members(prefix, { addition: 'RecipeIngredient', base: 'RecipeIngredient', template: 'RecipeIngredient' });

    for (const suffix of ['Addition', 'Base', 'Template']) {
      replace(prefix + suffix, '');
    }

    imports = 'import type { RecipeIngredient } from \'../../../../recipes/parts\';\n';
  }

  return finish({}, imports, `\nexport type { ${name} as default };\n`);
}
