export interface JsonFormatting {
  indent?: 'space' | 'tab';
  size?: number;
}

export interface I18nSettings {
  sourceDir?: string;
  defaultLocale?: string;
  namespace?: string;
  strict?: boolean;
  pretty?: JsonFormatting | false;
  types?: boolean;
  vanilla?: boolean;
  vanillaLangUrlTemplate?: string;
  cacheMaxAgeHours?: number;
  tsconfig?: string;
}

export interface TranslationPack {
  path: string;
  kind: 'behavior' | 'resource';
}

export interface I18nOptions extends I18nSettings {
  root: string;
  namespace: string;
  packs?: readonly TranslationPack[];
  dependencyRoot?: string;
  aliases?: Record<string, string>;
  outputDir?: string;
  typesDir?: string;
  cacheDir?: string;
  /** Authored source root used by declarations when resources are staged elsewhere. */
  declarationRoot?: string;
  signal?: AbortSignal;
  warn?: (message: string) => void;
  compile?: (options: BundleOptions) => Promise<CompiledModule>;
}

/** JSON consumed by @bedrock-core/i18n; resources are represented only in declarations. */
export interface TranslationBundle {
  namespace: string;
  defaultLocale: string;
  libs: string[];
  args: Record<string, string[]>;
  extra: Record<string, Record<string, string>>;
  locales: Record<string, Record<string, string>>;
}

export interface I18nResult {
  bundle?: TranslationBundle;
  bundlePath?: string;
  files: string[];
  inputs: string[];
  declarations: string[];
  warnings: string[];
}
import type { BundleOptions, CompiledModule } from '@bedrock-core/builder-bundler';
