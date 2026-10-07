import { createAccessResolver } from './access.ts';
import { compilePage } from './compile.ts';
import { resolveInternalLink } from './inline.ts';
import { catKey, pageKey } from './keys.ts';
import { humanizeFilename, parseGuideFile } from './parse.ts';
import { buildSidebar } from './sidebar.ts';
import type { CompiledBlock, CompiledPage, GuideDiagnostic, GuideManifest, GuidePageCompilation, GuidePageData } from './types.ts';

export interface Report {
  warn(scope: string, message: string): void;
  error(scope: string, message: string): void;
}

export interface LocaleBuild {
  pages: Map<string, CompiledPage>;
  lang: Map<string, string>;
  pageIds: Set<string>;
}

export interface GuidePageInput {
  source: string;
  pageId: string;
  prefix: string;
  maxCodeLineBytes: number;
  imageSize?: (src: string) => { w: number; h: number } | undefined;
}

/** Compile a page independently of the current sidebar, categories and translations. */
export function compileGuidePage(input: GuidePageInput): GuidePageCompilation {
  const parsed = parseGuideFile(input.source);
  const diagnostics: GuideDiagnostic[] = [];
  const targets = new Set<string>();
  const { pageId, prefix } = input;
  const dir = pageId.includes('/') ? pageId.slice(0, pageId.lastIndexOf('/')) : '';
  const basename = pageId.slice(pageId.lastIndexOf('/') + 1);
  const result = compilePage(parsed.root, {
    ...input,
    frontmatter: parsed.frontmatter,
    fallbackTitle: humanizeFilename(basename),
    key: nodePath => pageKey(prefix, pageId, nodePath),
    resolveLink(url) {
      const target = resolveInternalLink(url, dir);

      if (target !== null) {
        targets.add(target);
      }

      return target;
    },
    getDefinition: parsed.getDefinition,
    warn: message => diagnostics.push({ level: 'warning', scope: pageId, message }),
    error: message => diagnostics.push({ level: 'error', scope: pageId, message }),
  });
  const icon = typeof parsed.frontmatter.icon === 'string' && parsed.frontmatter.icon !== '' ? parsed.frontmatter.icon : undefined;
  let descK: string | undefined;
  const description = parsed.frontmatter.description;

  if (typeof description === 'string' && description.trim() !== '') {
    descK = pageKey(prefix, pageId, '_desc');
    result.lang.set(descK, `§7${description.trim()}`);
  }

  return {
    page: {
      frontmatter: parsed.frontmatter,
      titleK: result.titleK,
      blocks: result.blocks,
      ...(icon === undefined ? {} : { icon }),
      ...(descK === undefined ? {} : { descK }),
    },
    lang: [...result.lang], targets: [...targets], diagnostics,
  };
}

/** Assemble fresh locale state from compiled pages; cached page IR is never mutated. */
export function assembleLocale(
  compiled: Map<string, GuidePageCompilation>,
  categories: Map<string, Record<string, unknown>>,
  prefix: string,
  report: Report,
  targets = new Set(compiled.keys()),
): LocaleBuild {
  const pages = new Map<string, CompiledPage>();
  const lang = new Map<string, string>();

  for (const [pageId, result] of compiled) {
    for (const diagnostic of result.diagnostics) {
      report[diagnostic.level === 'warning' ? 'warn' : 'error'](diagnostic.scope, diagnostic.message);
    }

    for (const target of result.targets) {
      if (!targets.has(target)) {
        report.error(pageId, `broken internal link: "${target}"`);
      }
    }

    pages.set(pageId, structuredClone(result.page));

    for (const [key, value] of result.lang) {
      lang.set(key, value);
    }
  }

  for (const [dirPath, category] of categories) {
    if (typeof category.label === 'string') {
      lang.set(catKey(prefix, dirPath), category.label);
    }
  }

  return { pages, lang, pageIds: new Set(compiled.keys()) };
}

export function buildManifest({ build, categories, prefix, ns, defaultLocale, locales, report }: {
  build: LocaleBuild;
  categories: Map<string, Record<string, unknown>>;
  prefix: string;
  ns: string;
  defaultLocale: string;
  locales: string[];
  report: Report;
}): GuideManifest<CompiledBlock> {
  const access = createAccessResolver({ categories, warn: message => report.warn('access', message) });
  const { tree, order, publicOrder } = buildSidebar({
    pages: build.pages, categories, prefix,
    addLang(key, value) {
      if (!build.lang.has(key)) {
        build.lang.set(key, value);
      }
    },
    warn: message => report.warn('sidebar', message), access,
  });
  const pages: Record<string, GuidePageData<CompiledBlock>> = {};

  for (const [pageId, page] of build.pages) {
    pages[pageId] = { id: pageId, titleK: page.titleK, blocks: page.blocks };
    const level = access.forPage(pageId, page.frontmatter);

    if (level !== undefined) {
      pages[pageId].a = level;
    }
  }

  order.forEach((pageId, index) => {
    if (index > 0) {
      pages[pageId].prev = order[index - 1];
    }

    if (index < order.length - 1) {
      pages[pageId].next = order[index + 1];
    }
  });
  const manifest: GuideManifest<CompiledBlock> = { v: 1, ns, defaultLocale, locales, tree, pages };

  if (access.used()) {
    manifest.gated = true;
    publicOrder.forEach((pageId, index) => {
      if (index > 0) {
        pages[pageId].pprev = publicOrder[index - 1];
      }

      if (index < publicOrder.length - 1) {
        pages[pageId].pnext = publicOrder[index + 1];
      }
    });
  }

  const home = [...build.pages].filter(([, page]) => page.frontmatter.home === true).map(([id]) => id);

  if (home.length > 1) {
    report.warn('home', `${home.length} pages set "home: true" (${home.join(', ')}) — using "${home[0]}"`);
  }

  if (home.length) {
    manifest.home = home[0];
  }

  return manifest;
}
