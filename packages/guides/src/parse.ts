import type { Root } from 'mdast';
import type { GuideNode } from './types.ts';
// MDX/markdown parsing — one unified pipeline for every guide file.
//
// Both .md and .mdx run through the same processor (including remark-mdx) so
// document structure never depends on the file extension — key assignment
// must stay identical across locales. Consequence: a literal '<' in prose
// must be escaped (\<), exactly like Docusaurus in MDX mode.

import { definitions } from 'mdast-util-definitions';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkDirective)
  .use(remarkMdx);

/**
 * Parse one guide source file.
 *
 * Throws on MDX syntax errors; the caller reports file + message.
 *
 */
export function parseGuideFile(source: string): {
  frontmatter: Record<string, unknown>;
  root: GuideNode;
  getDefinition: (id: string) => GuideNode | undefined;
} {
  const parsed = processor.runSync(processor.parse(source)) as Root;
  const root = parsed as unknown as GuideNode;

  let frontmatter: Record<string, unknown> = {};

  if (root.children![0]?.type === 'yaml') {
    const value: unknown = parseYaml(root.children![0].value ?? '');

    if (value !== null && value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('frontmatter must be an object');
    }

    frontmatter = value as Record<string, unknown> ?? {};
    root.children = root.children!.slice(1);
  }

  return { frontmatter, root, getDefinition: definitions(parsed) as (id: string) => GuideNode | undefined };
}

/** 'first-screen' → 'First Screen' — last-resort page title. */
export function humanizeFilename(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
