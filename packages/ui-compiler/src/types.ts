import type { Document } from './hooks.ts';
import type { PackLocales } from './lang.ts';

/** Screen discovery, output formatting and optional metadata settings for the UI stage. */
export interface UiSettings {
  /** Builder owner ID; defaults to the sole script pack or sole pack. */
  owner?: string;
  /** Builder resource destination ID; inferred from direct local dependencies. */
  resourcePack?: string;
  /** Override the project namespace for generated UI content. */
  namespace?: string;
  /** Emit optional screen identity metadata. */
  testMetadata?: boolean;
  /** Emit a build stamp in generated output. */
  stamp?: boolean;
  /** Explicit screen-source globs. */
  screens?: string[];
  /** JSON output indentation. */
  pretty?: false | { indent?: 'space' | 'tab'; size?: number };
  /** TypeScript module-resolution configuration. */
  tsconfig?: string;
  /** Client and fallback resource roots used only when an Experimental_OreUI screen is compiled. */
  experimentalOre?: {
    /** Windows client Content directory. Relative paths resolve from the project; omitted selects matching installed assets. */
    clientRoot?: string;
    /** Additional resource-pack directories, searched after the selected output RP in listed order. */
    resourceRoots?: string[];
    /** Pack-local PNG paths that live image values may select at runtime. */
    dynamicTextures?: string[];
  };
}

/** Authored screen module and export selected for compilation. */
export interface ScreenEntry {
  /** Authored or generated screen module path. */
  source: string;
  /** Screen export name. */
  name: string;
  /** Member selected from a screen collection, when applicable. */
  member?: string;
}

/** Compiled screen data consumed by linking and resource/host writers. */
export interface ScreenData {
  kind?: 'action' | 'modal' | 'custom';
  ore?: unknown;
  parameters?: unknown;
  name: string;
  addon: string;
  namespace: string;
  document: Document;
  facesNamespace: string;
  faces: Record<string, unknown>;
  hasBackdrop: boolean;
  /** Reserved server-form values, including markers and embedded slots. */
  entryCount?: number;
  lang?: Record<string, Record<string, string>>;
  testMetadata?: unknown;
  host?: { kind: 'entity' | 'block'; type: string };
  layoutId?: number;
  allocation?: { size: number };
  looks?: unknown[];
  hasText?: boolean;
  title?: string;
  snapshot?: {
    shape: string;
    vis: readonly number[];
    baked?: readonly string[];
    texts?: readonly number[];
    ore?: unknown;
    data?: Readonly<Record<string, unknown>>;
  };
  table?: {
    values: readonly string[];
    actions: readonly unknown[];
  };
}

/** Relative output filename and linked JSON UI document. */
export interface UiDocument {
  file: string;
  document: Document;
}

/** Complete linked screen set with JSON UI, host protocol and language outputs. */
export interface LinkedUi {
  resources?: { file: string; text: string }[];
  screens: ScreenData[];
  hooks: UiDocument[];
  documents: UiDocument[];
  lang: string[];
  layoutProperty: string;
  maxLayout: number;
  blockSlotLimit: number;
  items: Record<string, { role: string; document: Document }[]>;
}

/** Shared bundled toolkit and locale data supplied to screen-evaluation workers. */
export interface UiEnvironment {
  /** Absolute shared toolkit bundle path. */
  library: string;
  /** Compiled translation bundle supplied to the worker. */
  i18n?: unknown;
  /** Pack language tables supplied to screen compilation. */
  locales?: PackLocales;
}

/** Sequential worker operation for export discovery, screen compilation or pack linking. */
export type UiRequest
  = | { kind: 'exports' }
    | { kind: 'list'; module: string }
    | { kind: 'screen'; module: string; name: string; member?: string; namespace: string; testMetadata?: boolean }
    | { kind: 'link'; screens: ScreenData[]; namespace: string };

export interface UiLibrary {
  guides?: Record<string, unknown>;
  ui: Record<string, unknown>;
  jsx: Record<string, unknown>;
  compiler: {
    compileScreen(screen: unknown, spec: object): ScreenData & { face?: unknown; entries?: unknown };
    compileFormScreen(screen: unknown, spec: object): ScreenData & { face?: unknown; entries?: unknown };
    compileExperimentalOreScreen?(screen: unknown, spec: object): ScreenData;
    buildUiPack(screens: ScreenData[], namespace: string): Pick<LinkedUi, 'screens' | 'hooks' | 'documents' | 'resources'>;
  };
  runtime: Record<string, unknown> & {
    buildScreenTree(screen: unknown): unknown;
    hostFor(tree: unknown): { id: string };
    setBuildLocales(locales: PackLocales): void;
    charsetLang?(): string[];
    protocolItemDefinitions?: (namespace: string) => LinkedUi['items'][string];
    LAYOUT_PROPERTY: string;
    MAX_LAYOUT: number;
    BLOCK_SLOT_LIMIT: number;
  };
  i18n: { createI18n(bundle: unknown): void };
}
