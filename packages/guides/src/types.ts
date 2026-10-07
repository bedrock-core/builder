export interface InlineLink {
  to: string;
  at: [number, number];
}

export interface GuidesSettings {
  namespace?: string;
  sourceDir?: string;
  defaultLocale?: string;
  include?: string[];
  exclude?: string[];
  maxCodeLineBytes?: number;
  strictLocales?: boolean;
  compileScreens?: boolean;
  screensDir?: string;
  screenTitle?: string;
  componentsModule?: string;
  manifestPath?: string;
  pretty?: false | { indent?: 'space' | 'tab'; size?: number };
}

export type GuideAccess = 'op';
export type AdmonitionKind = 'note' | 'tip' | 'info' | 'warning' | 'danger';
export type GuideInline = { k: string } | { text: Record<string, string>; links: string[] };
export type GuideListItem = GuideInline & { items?: GuideListItem[] };
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

export type GuideTreeNode
  = | { t: 'page'; id: string; titleK: string; icon?: string; descK?: string; a?: GuideAccess }
    | { t: 'cat'; id: string; labelK: string; collapsed?: boolean; link?: string; icon?: string; a?: GuideAccess; children: GuideTreeNode[] };

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

export interface CompiledListItem extends CompiledInline {
  items?: CompiledListItem[];
}

export type CompiledBlock = GuideBlock<CompiledInline, CompiledListItem>;

export interface CompiledPage {
  frontmatter: Record<string, unknown>;
  titleK: string;
  blocks: CompiledBlock[];
  icon?: string;
  descK?: string;
}

export interface GuideDiagnostic {
  level: 'warning' | 'error';
  scope: string;
  message: string;
}

export interface GuidePageCompilation {
  page: CompiledPage;
  lang: [string, string][];
  /** Normalized internal links, validated against the current page set during assembly. */
  targets: string[];
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
