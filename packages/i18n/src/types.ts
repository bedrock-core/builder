/** Indentation used when pretty JSON output is enabled. */
export interface JsonFormatting {
  /** Indentation character; defaults to spaces. */
  indent?: 'space' | 'tab';
  /** Count of indentation characters; defaults to two spaces or one tab. */
  size?: number;
}

/** Locale source discovery, validation, formatting and editor-declaration settings. */
export interface I18nSettings {
  /** Limit the builder to one configured owner; omission discovers inputs per pack. */
  owner?: string;
  /** Resource destination ID in the builder; inferred from the owner's local dependencies. */
  resourcePack?: string;
  /** Emit client language files unless false; false compiles runtime data only. */
  client?: boolean;
  /** Locale directory relative to each owner pack in the builder, or root in the standalone API. */
  sourceDir?: string;
  /** Required fallback locale; defaults to en_US. */
  defaultLocale?: string;
  /** Project namespace used to qualify generated keys. */
  namespace?: string;
  /** Fail on locale/key problems unless explicitly false. */
  strict?: boolean;
  /** Runtime JSON formatting; false or omission emits compact JSON. */
  pretty?: JsonFormatting | false;
  /** Generate editor declarations unless explicitly false. */
  types?: boolean;
  /** Include optional vanilla language-key declarations. */
  vanilla?: boolean;
  /** Download template for vanilla locale files. */
  vanillaLangUrlTemplate?: string;
  /** Maximum age of cached vanilla language downloads. */
  cacheMaxAgeHours?: number;
  /** TypeScript module-resolution configuration. */
  tsconfig?: string;
}

/** Pack destination and manifest type for generated language files. */
export interface TranslationPack {
  /** Manifest alias destinations; omission uses pack.name/pack.description, empty object emits neither. */
  aliases?: { name?: string; description?: string };
  /** Shared defaults used to distinguish generated display defaults from authored pack-specific text. */
  metadata?: { name: string; description: string };
  /** Destination directory relative to root, or absolute. */
  path: string;
  /** Manifest type used for generated language-file behavior. */
  kind: 'behavior' | 'resource';
}

/** Project paths and integrations for compiling a translation library. */
export interface I18nOptions extends I18nSettings {
  /** Generated module declaration name; defaults to @bedrock-core/generated/i18n. */
  moduleName?: string;
  /** Per-producer section identity for composing output into a shared resource pack. */
  section?: string;
  /** Final declaration directory when emitting declarations to temporary staging. */
  declarationDir?: string;
  /** Default meta fields; authored locale values override these defaults. */
  metadata?: { name: string; description: string; creator: string };
  /** Path-resolution root; standalone callers normally supply the owning pack directory. */
  root: string;
  /** Required runtime bundle namespace. */
  namespace: string;
  /** Pack destinations for language files and locale catalogs. */
  packs?: readonly TranslationPack[];
  /** Authored module-resolution root for staged resource modules. */
  dependencyRoot?: string;
  /** Custom/generated imports mapped to files. */
  aliases?: Record<string, string>;
  /** Runtime bundle directory; defaults to .bedrock-core/generated/i18n. */
  outputDir?: string;
  /** Editor-declaration directory; defaults to outputDir. */
  typesDir?: string;
  /** Directory for downloaded translation dependencies. */
  cacheDir?: string;
  /** Authored source root used by declarations when resources are staged elsewhere. */
  declarationRoot?: string;
  /** Cooperative compile/download cancellation. */
  signal?: AbortSignal;
  /** Diagnostic sink for nonfatal compilation issues. */
  warn?: (message: string) => void;
  /** Optional compiler implementation used to evaluate resource modules. */
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

/** Generated translation bundle, language files, declarations and diagnostics. */
export interface I18nResult {
  /** Compiled runtime data, absent when there are no locale inputs. */
  bundle?: TranslationBundle;
  /** Written runtime JSON path when a bundle exists. */
  bundlePath?: string;
  /** Written runtime and pack language outputs. */
  files: string[];
  /** Observed locale, module and language dependencies. */
  inputs: string[];
  /** Written editor declarations. */
  declarations: string[];
  /** Nonfatal compilation diagnostics. */
  warnings: string[];
}
import type { BundleOptions, CompiledModule } from '@bedrock-core/builder-bundler';
