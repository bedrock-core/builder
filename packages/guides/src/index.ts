import { compileProject, type GuidesOptions, type GuidesResult } from './project.ts';
export type { GuidesOptions, GuidesResult } from './project.ts';
export type { GuidesSettings, GuideManifest, GuideBlock, GuideTreeNode, GuidePageData } from './types.ts';
export { compileGuidePage, assembleLocale, buildManifest } from './build.ts';
export type { GuidePageInput, LocaleBuild, Report } from './build.ts';

/** Compile trusted Markdown/MDX content without the builder or guide runtime installed. */
export async function compileGuides(options: GuidesOptions): Promise<GuidesResult> {
  return compileProject(options);
}
