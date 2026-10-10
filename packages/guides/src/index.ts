import { compileProject, type GuidesOptions, type GuidesResult } from './project.ts';
export type { GuidesOptions, GuidesResult } from './project.ts';
export type { GuidesSettings, GuideManifest, GuideBlock, GuideTreeNode, GuidePageData } from './types.ts';
export { compileGuidePage, assembleLocale, buildManifest } from './build.ts';
export type { GuidePageInput, LocaleBuild, Report } from './build.ts';

/**
 * Compile trusted Markdown/MDX content without the builder or guide runtime installed.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns Guide manifest, generated files, declarations, diagnostics and page counts.
 * @remarks Screen generation needs a behavior pack. compileScreens: false emits guide content without generated screen modules.
 */
export async function compileGuides(options: GuidesOptions): Promise<GuidesResult> {
  return compileProject(options);
}
