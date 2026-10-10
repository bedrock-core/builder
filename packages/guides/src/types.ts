/** Normalized guide destination and half-open character range inside inline text. */
export interface InlineLink {
  to: string;
  at: [number, number];
}

/** Guide source selection, localization, navigation and optional screen generation. */
export interface GuidesSettings {
  /** Override the project namespace for generated guide keys. */
  namespace?: string;
  /** Guide content directory; defaults to guides. */
  sourceDir?: string;
  /** Guide fallback locale; defaults to en_US. */
  defaultLocale?: string;
  /** Source globs; defaults to Markdown and MDX files. */
  include?: string[];
  /** Source exclusion globs. */
  exclude?: string[];
  /** Maximum displayed code-line bytes; defaults to 60, valid range 4 through 80. */
  maxCodeLineBytes?: number;
  /** Fail when locale reconciliation finds unsupported inconsistencies. */
  strictLocales?: boolean;
  /** Generate guide screen modules for the UI stage. */
  compileScreens?: boolean;
  /** Destination for generated screen source modules. */
  screensDir?: string;
  /** Title baked into generated guide screens. */
  screenTitle?: string;
  /** Module whose default export maps custom guide components. */
  componentsModule?: string;
  /** Generated guide manifest path. */
  manifestPath?: string;
  /** Manifest JSON indentation. */
  pretty?: false | { indent?: 'space' | 'tab'; size?: number };
}

/** Operator-only access marker for guide pages and categories. */
export type GuideAccess = 'op';
/** Supported semantic kinds for guide admonition blocks. */
export type AdmonitionKind = 'note' | 'tip' | 'info' | 'warning' | 'danger';
/** Runtime inline content represented by a language key or linked text. */
export type GuideInline = { k: string } | { text: Record<string, string>; links: string[] };
/** Inline guide list entry with optional nested items. */
export type GuideListItem = GuideInline & { items?: GuideListItem[] };
/** Discriminated runtime guide blocks consumed by the guide renderer. */
export type GuideBlock<Inline = GuideInline, Item = GuideListItem>
  = | { t: 'h'; l: 1 | 2 | 3; k: string }
    | ({ t: 'p' } & Inline)
    | { t: 'ul'; items: Item[] }
    | { t: 'ol'; items: Item[]; start?: number }
    | { t: 'img'; src: string; alt?: string; w?: number; h?: number }
    | { t: 'adm'; kind: AdmonitionKind; titleK?: string; blocks: GuideBlock<Inline, Item>[] }
    | { t: 'code'; lang?: string; lines: string[] }
    | { t: 'hr' }
    | { t: 'cmp'; name: string; props?: Record<string, unknown>; blocks?: GuideBlock<Inline, Item>[] };

/** Localized page or category entry in the guide navigation tree. */
export type GuideTreeNode
  = | { t: 'page'; id: string; titleK: string; icon?: string; descK?: string; a?: GuideAccess }
    | { t: 'cat'; id: string; labelK: string; collapsed?: boolean; link?: string; icon?: string; a?: GuideAccess; children: GuideTreeNode[] };

/** Runtime page blocks with navigation links and optional operator access. */
export interface GuidePageData<Block = GuideBlock> {
  id: string;
  titleK: string;
  blocks: Block[];
  prev?: string;
  next?: string;
  a?: GuideAccess;
  pprev?: string;
  pnext?: string;
}

/** Versioned guide content and navigation consumed by the runtime package. */
export interface GuideManifest<Block = GuideBlock> {
  v: 1;
  ns: string;
  defaultLocale: string;
  locales: string[];
  tree: GuideTreeNode[];
  pages: Record<string, GuidePageData<Block>>;
  gated?: true;
  home?: string;
  screens?: Record<string, string>;
  opScreens?: Record<string, string>;
}

/** Page IR before locale linking replaces keyed spans with tagged strings. */
export interface CompiledInline {
  k?: string;
  links?: InlineLink[] | string[];
  text?: Record<string, string>;
}

/** Intermediate inline list item with optional nested entries. */
export interface CompiledListItem extends CompiledInline {
  items?: CompiledListItem[];
}

/** Guide block using intermediate inline and list representations. */
export type CompiledBlock = GuideBlock<CompiledInline, CompiledListItem>;

/** Parsed page metadata and intermediate localized blocks. */
export interface CompiledPage {
  frontmatter: Record<string, unknown>;
  titleK: string;
  blocks: CompiledBlock[];
  icon?: string;
  descK?: string;
}

/** Guide compilation warning or error scoped to a page or locale. */
export interface GuideDiagnostic {
  /** Warning or error severity. */
  level: 'warning' | 'error';
  /** Affected page or locale. */
  scope: string;
  /** Actionable diagnostic text. */
  message: string;
}

/** One parsed guide page with language entries, link targets and diagnostics. */
export interface GuidePageCompilation {
  /** Parsed localized page content. */
  page: CompiledPage;
  /** Generated language-key/value pairs. */
  lang: [string, string][];
  /** Normalized internal links, validated against the current page set during assembly. */
  targets: string[];
  /** Page compilation issues. */
  diagnostics: GuideDiagnostic[];
}

/** Supported fields of remark's MDX tree, projected at the parser boundary. */
export interface GuideNode {
  type: string;
  children?: GuideNode[];
  value?: string;
  url?: string;
  identifier?: string;
  name?: string | null;
  alt?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  lang?: string | null;
  data?: { directiveLabel?: boolean };
  attributes?: { type: string; name: string; value?: string | null | { value: string } }[];
}
