import type { Document } from './hooks.ts';
import type { PackLocales } from './lang.ts';

export interface UiSettings {
  namespace?: string;
  testMetadata?: boolean;
  stamp?: boolean;
  screens?: string[];
  pretty?: false | { indent?: 'space' | 'tab'; size?: number };
  tsconfig?: string;
}

export interface ScreenEntry {
  source: string;
  name: string;
  member?: string;
}

export interface ScreenData {
  name: string;
  addon: string;
  namespace: string;
  document: Document;
  face: { document: Document };
  facesNamespace: string;
  faces: Record<string, unknown>;
  hasBackdrop: boolean;
  lang?: Record<string, Record<string, string>>;
  testMetadata?: unknown;
  host?: { kind: 'entity' | 'block'; type: string };
  layoutId?: number;
  allocation?: { size: number };
  looks?: unknown[];
  hasText?: boolean;
  title?: string;
  entries?: unknown[];
  snapshot?: { shape: string; baked: readonly string[]; vis: readonly number[] };
  table?: {
    values: readonly string[];
    targets: readonly unknown[];
  };
}

export interface UiDocument {
  file: string;
  document: Document;
}

export interface LinkedUi {
  screens: ScreenData[];
  hooks: UiDocument[];
  documents: UiDocument[];
  lang: string[];
  layoutProperty: string;
  maxLayout: number;
  blockSlotLimit: number;
  items: Record<string, { role: string; document: Document }[]>;
}

export interface UiEnvironment {
  library: string;
  i18n?: unknown;
  locales?: PackLocales;
}

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
    compileScreen(screen: unknown, spec: object): ScreenData;
    compileFormScreen(screen: unknown, spec: object): ScreenData;
    buildUiPack(screens: ScreenData[], namespace: string): Pick<LinkedUi, 'screens' | 'hooks' | 'documents'>;
  };
  runtime: Record<string, unknown> & {
    buildScreenOnce(screen: unknown): unknown;
    hostFor(tree: unknown): { id: string };
    setBuildLocales(locales: PackLocales): void;
    charsetLang(): string[];
    protocolItemDefinitions?: (namespace: string) => LinkedUi['items'][string];
    LAYOUT_PROPERTY: string;
    MAX_LAYOUT: number;
    BLOCK_SLOT_LIMIT: number;
  };
  i18n: { createI18n(bundle: unknown): void };
}
