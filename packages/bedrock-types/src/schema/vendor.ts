import fs from 'node:fs';
import path from 'node:path';
import { normalizeRecipes } from '../fixes/recipes.ts';

export const recipes = [
  { file: 'RecipeBrewingMix', name: 'BrewingMixRecipeDocument' },
  { file: 'RecipeFurnace', name: 'FurnaceRecipeDocument' },
  { file: 'RecipeShaped', name: 'ShapedRecipeDocument' },
  { file: 'RecipeShapeless', name: 'ShapelessRecipeDocument' },
  { file: 'RecipeSmithingTransform', name: 'SmithingTransformRecipeDocument' },
  { file: 'RecipeSmithingTrim', name: 'SmithingTrimRecipeDocument' },
];

export async function copyVendorFiles(
  typesRoot: string,
  vendorDir: string,
  categories: readonly string[],
): Promise<number> {
  let copied = 0;
  const files = [
    'common/index.d.ts',
    ...(categories.includes('bp/items')
      ? ['MinecraftItemV1260', 'MinecraftItemV12190', 'MinecraftPiercingWeapon', 'MinecraftKineticWeapon']
          .map(name => 'bp/items/components/' + name + '.d.ts')
      : []),
    ...(categories.includes('bp/recipes') ? recipes.map(recipe => 'bp/recipes/' + recipe.file + '.d.ts') : []),
  ];

  for (const rel of files) {
    const src = path.join(typesRoot, rel);

    if (!fs.existsSync(src)) {
      throw new Error('Required upstream declaration is missing: ' + rel);
    }

    const dest = path.join(vendorDir, rel);

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (rel.startsWith('bp/recipes/')) {
      fs.writeFileSync(dest, normalizeRecipes(fs.readFileSync(src, 'utf8'), path.basename(rel, '.d.ts')));
    } else {
      fs.copyFileSync(src, dest);
    }

    copied++;
  }

  return copied;
}
