import { createAccessResolver } from './access.ts';
import { compilePage } from './compile.ts';
import { resolveInternalLink } from './inline.ts';
import { catKey, pageKey } from './keys.ts';
import { humanizeFilename, parseGuideFile } from './parse.ts';
import { buildSidebar } from './sidebar.ts';
import type { CompiledBlock, CompiledPage, GuideDiagnostic, GuideManifest, GuidePageCompilation, GuidePageData } from './types.ts';

/** Diagnostic sink supplied to guide assembly and manifest construction. */
export interface Report {
  warn(scope: string, message: string): void;
  error(scope: string, message: string): void;
}

/** Assembled locale pages, language entries and known page IDs. */
export interface LocaleBuild {
  /** Compiled pages indexed by page ID. */
  pages: Map<string, CompiledPage>;
  /** Generated language keys and text. */
  lang: Map<string, string>;
  /** Known page identifiers used for link validation. */
  pageIds: Set<string>;
}

/** MDX source and naming/image constraints for compiling one guide page. */
export interface GuidePageInput {
  /** Markdown/MDX content to parse. */
  source: string;
  /** Normalized guide page identifier. */
  pageId: string;
  /** Namespace prefix for generated language keys. */
  prefix: string;
  /** Maximum encoded length for displayed code lines. */
  maxCodeLineBytes: number;
  /** Optional image-dimension lookup for referenced textures. */
  imageSize?: (src: string) => { w: number; h: number } | undefined;
}

/**
 * Compile a page independently of the current sidebar, categories and translations.
 * @param input Source data accepted by this operation.
 * @returns Parsed page content, generated language entries, link targets and diagnostics.
 * @remarks Compiles a single page independently; current-set link and navigation checks belong to assembleLocale.
 */
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

/**
 * Assemble fresh locale state from compiled pages; cached page IR is never mutated.
 * @param compiled Current locale page compilations indexed by normalized page ID.
 * @param categories Current category metadata indexed by category ID.
 * @param prefix Namespace prefix for generated language keys.
 * @param report Warning/error sink used by locale assembly.
 * @param targets Known page IDs for link validation; defaults to the compiled page IDs.
 * @returns Assembled locale pages, language entries and validated page IDs.
 */
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

/**
 * Build a runtime guide manifest from the assembled current locale and categories.
 * @param input Current locale build, categories, namespace, locale names and diagnostic sink.
 * @returns Guide runtime manifest with its sidebar, access gates and locale metadata.
 */
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
