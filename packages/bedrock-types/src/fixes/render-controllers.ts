import { declarationEdits } from '../schema/patch.ts';

export const renderControllerTypes = [
  'RenderControllerDocument', 'RenderController', 'RenderControllerArrays', 'RenderControllerColor', 'RenderControllerUVAnimation',
] as const;

/** Correct dynamic maps, expression values and UV vectors in native render-controller declarations. */
export function normalizeRenderControllers(text: string): string {
  const { members, replace, finish } = declarationEdits(text);
  const prefix = 'RenderControllerRenderControllers';

  members(prefix, {
    light_color_multiplier: 'MolangExpression',
    materials: 'Record<string, string>[]',
    part_visibility: 'Record<string, boolean | MolangExpression>[]',
    is_hurt_color: 'RenderControllerColor',
    on_fire_color: 'RenderControllerColor',
    overlay_color: 'RenderControllerColor',
  });
  members(prefix + 'Arrays', { geometries: 'Record<string, string[]>', materials: 'Record<string, string[]>', textures: 'Record<string, string[]>' });
  members(prefix + 'Color', { r: 'MolangExpression', g: 'MolangExpression', b: 'MolangExpression', a: 'MolangExpression' });
  members(prefix + 'UvAnim', { offset: 'MolangVector2', scale: 'MolangVector2' });

  for (const suffix of ['ArraysGeometries', 'ArraysMaterials', 'ArraysTextures', 'IsHurtColor', 'Materials', 'OnFireColor', 'OverlayColor', 'PartVisibility']) {
    replace(prefix + suffix, '');
  }

  return finish({
    RenderController: 'RenderControllerDocument',
    [prefix]: 'RenderController',
    [prefix + 'Arrays']: 'RenderControllerArrays',
    [prefix + 'Color']: 'RenderControllerColor',
    [prefix + 'UvAnim']: 'RenderControllerUVAnimation',
  }, 'import type { MolangExpression, MolangVector2 } from \'../common/index\';\n');
}
