import fs from 'node:fs';
import path from 'node:path';
import { categoryKey, documents } from '../layout.ts';
import { normalizeSchemaTree, object, type Log, type SchemaNode } from './normalize.ts';
import { copyVendorFiles, recipes } from './vendor.ts';
import { animationTypes, normalizeAnimations } from '../fixes/animations.ts';
import { normalizeRenderControllers, renderControllerTypes } from '../fixes/render-controllers.ts';
import { normalizeTrading } from '../fixes/trading.ts';
import { featureDocumentType } from '../fixes/features.ts';

export interface Category {
  key: string;
  name: string;
  file: string;
  names?: readonly string[];
}

interface CompileOptions {
  source: string;
  output: string;
  categories: readonly string[];
  log: Log;
}

const preambles: Record<string, string> = {
  'bp/items': 'import type { ItemComponents } from \'./registry\';',
  'bp/blocks': 'import type { BlockComponents } from \'./registry\';',
  'bp/entities': 'import type { EntityComponents } from \'./registry\';\nimport type { EntityDescription } from \'./description\';\nimport type { EntityEventAction } from \'./events\';',
  'assets/entity-components': 'import type { EntityComponents } from \'./registry\';\nimport type { FilterGroup } from \'../common/filters\';',
  'bp/features': 'import type { ScatterDistribution } from \'./parts\';',
  'bp/feature_rules': 'import type { FeaturePlacementPass, ScatterDistribution } from \'./parts\';\nimport type { FilterGroup } from \'../common/filters\';',
  'assets/client-resource': 'import type { MolangExpression, ConditionalReference } from \'./primitives\';',
  'rp/entity': 'import type { ClientResourceDescription } from \'../common/client-resource\';',
  'rp/attachables': 'import type { ClientResourceDescription } from \'../common/client-resource\';\nimport type { MolangExpression } from \'../common/primitives\';',
  'rp/textures/terrain_texture': 'import type { TextureAtlasEntry } from \'./parts\';',
  'rp/textures/item_texture': 'import type { TextureAtlasEntry } from \'./parts\';',
  'rp/textures/blocks_resource': 'import type { BlockTextureBindings, BlockTextureFace } from \'./parts\';',
  'rp/models': 'import type { LegacyModelGeometry, ItemDisplayTransforms } from \'./parts\';',
};

/** Compile known document roots with stable names and purpose-based output paths. */
export async function compileCatalog({ source, output, categories: requested, log }: CompileOptions): Promise<Category[]> {
  const { compileFromFile } = await import('json-schema-to-typescript');

  const catalog = JSON.parse(fs.readFileSync(path.join(source, 'catalog.json'), 'utf8')) as { schemas: { url: string }[] };
  const categories: Category[] = [];
  const seen = new Set<string>();

  normalizeSchemaTree(path.join(source, 'schemas'), log);
  const vendor = path.join(output, 'internal/upstream');

  if (requested.includes('bp/items') || requested.includes('bp/recipes')) {
    await copyVendorFiles(path.join(source, 'types'), vendor, requested);
  }

  for (const entry of catalog.schemas) {
    const key = categoryKey(entry.url);

    if (!requested.includes(key)) {
      continue;
    }

    const definition = documents[key];

    if (!definition || seen.has(definition.name)) {
      throw new Error(`Unknown category or duplicate document name: ${key}`);
    }

    seen.add(definition.name);
    const file = path.join(source, entry.url.replace(/^\.?\//, ''));
    const schema = JSON.parse(fs.readFileSync(file, 'utf8')) as SchemaNode;
    const item = key === 'bp/items';
    const target = path.join(output, definition.file + '.d.ts');
    const relative = path.relative(path.dirname(target), vendor).replaceAll('\\', '/');

    if (key === 'bp/animations' || key === 'bp/animation_controllers' || key === 'rp/render_controllers') {
      const controller = key === 'bp/animation_controllers';
      const render = key === 'rp/render_controllers';
      const input = path.join(source, 'types/rp/visuals', render ? 'RenderController.d.ts' : controller ? 'ActorAnimationController.d.ts' : 'ActorAnimation.d.ts');
      const upstream = fs.readFileSync(input, 'utf8');
      const body = render ? normalizeRenderControllers(upstream) : normalizeAnimations(upstream, controller);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      categories.push({ key, ...definition, names: render ? renderControllerTypes : animationTypes[key] });
      continue;
    }

    if (key === 'bp/recipes') {
      const lines = recipes.map(recipe => `import type ${recipe.name} from '${relative}/bp/recipes/${recipe.file}';`);

      lines.push('import type { BrewingContainerRecipeDocument } from \'./parts\';');
      lines.push(
        `export type { ${recipes.map(recipe => recipe.name).join(', ')} };`,
        `export type RecipeDocument = ${recipes.map(recipe => recipe.name).join(' | ')} | BrewingContainerRecipeDocument;`,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, lines.join('\n'));
      categories.push({ key, ...definition, names: [definition.name, ...recipes.map(recipe => recipe.name)] });
      continue;
    }

    if (key === 'bp/trading') {
      const input = path.join(source, 'types/bp/trading/TradeTable.d.ts');

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, normalizeTrading(fs.readFileSync(input, 'utf8')));
      categories.push({ key, ...definition });
      continue;
    }

    if (item) {
      const components = object(object(object(object(schema.properties)?.['minecraft:item'])?.properties)?.components);

      if (components) {
        components.tsType = 'ItemComponents';
      }
    }

    const feature = key === 'bp/features';

    schema.title = feature ? 'FeatureProperties' : definition.name;
    const shim = path.join(path.dirname(file), '.bedrock-types.' + path.basename(file));
    let body: string;

    try {
      fs.writeFileSync(shim, JSON.stringify(schema));
      body = await compileFromFile(shim, {
        bannerComment: '',
        declareExternallyReferenced: true,
        unreachableDefinitions: false,
        additionalProperties: false,
        format: false,
      });
    } finally {
      fs.rmSync(shim, { force: true });
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      '// Generated by @bedrock-core/bedrock-types from Mojang schemas.\n' + (preambles[key] ?? '') + '\n' + body + (feature ? featureDocumentType : ''),
    );
    categories.push({ key, ...definition });
  }

  for (const key of requested) {
    if (!categories.some(category => category.key === key)) {
      throw new Error('Requested schema category was not compiled: ' + key);
    }
  }

  return categories.sort((left, right) => left.file.localeCompare(right.file));
}
