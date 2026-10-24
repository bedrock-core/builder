import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { builtinPlugins } from './builtins.ts';
export type { JsonFormatting } from '@bedrock-core/builder-plugin';
import type { JsonFormatting } from '@bedrock-core/builder-plugin';
import type { PackLinkOverrides } from '@bedrock-core/builder-plugin';

/** Built-in transformation names, in execution order. */
export type StageName = keyof typeof builtinPlugins;
/** JSON-compatible options passed unchanged to a stage or module plugin. */
export type Settings = Record<string, unknown>;
/** Omitted or `auto` detects inputs; `false` disables; `true` or options forces participation. */
export type StageSelection = 'auto' | boolean | Settings;
/** Conventional Regolith folders mapped to configured pack IDs. */
export interface ScriptFolders { BP?: string; RP?: string }
/** Standalone Node script run once in a temporary BP/RP/data workspace. */
export interface NodePluginDefinition {
  /** Entry file relative to filterDir, or an absolute file path. */
  script: string;
  /** Definition directory relative to config.json; defaults to projectRoot. */
  filterDir?: string;
  /** Configured pack IDs exposed under conventional folder names. Omission infers an unambiguous set. */
  folders?: ScriptFolders;
  /** Authored data directory copied into a shared working copy keyed by its source path. */
  dataPath?: string;
  /** Write this data source back only when publication succeeds; requires an explicit dataPath. */
  persistData?: boolean;
  /** Node flags placed before the entry file. */
  nodeArguments?: string[];
}
/** Native module with host-owned owner restrictions and dependency overrides. */
export interface ModulePluginDefinition {
  module: string;
  packs?: string[];
  links?: PackLinkOverrides;
  scope?: 'pack' | 'project';
}
/** A native module or standalone Node script definition. */
export type PluginDefinition = ModulePluginDefinition | NodePluginDefinition;
/** Named plugin invocation at exactly one boundary; equal-boundary steps retain array order. */
export type PluginStep = { plugin: string; settings?: Settings; arguments?: string[]; mode?: 'auto' | 'always'; packs?: string[]; links?: PackLinkOverrides; folders?: ScriptFolders; dataPath?: string; persistData?: boolean } & (
  { before: StageName | 'export'; after?: never } | { after: StageName | 'prepare'; before?: never }
);
/** Stage selection, ordered plugin hooks and export destinations for one named build. */
export interface BuildProfile {
  /** Generated JSON formatting inherited by stages; an explicit stage value replaces it. */
  pretty?: JsonFormatting | false;
  /** Debug output inherited by stages that use it; an explicit stage value replaces it. */
  debug?: boolean;
  /** Built-ins detect inputs unless disabled or explicitly enabled. */
  stages?: Partial<Record<StageName, StageSelection>>;
  /** Reuse verified compilation and validation results; defaults to true. */
  cache?: boolean;
  /** Invocations after prepare, before/after enabled stages, or before export. */
  steps?: PluginStep[];
  /** Destination for every configured pack ID, relative to config.json or absolute. */
  export?: Record<string, string>;
  /** Debounce interval and additional project-relative inputs for watch mode. */
  watch?: { debounceMs?: number; paths?: string[] };
}
/** Bedrock project metadata and builder configuration; unrelated tool fields are preserved. */
export interface ProjectConfig {
  /** Editor schema reference; has no effect on path resolution. */
  $schema?: string;
  /** Target Minecraft version used by participating stages. */
  targetVersion: string;
  /** Default namespace for generated content. */
  namespace: string;
  /** Human-readable project name. */
  name: string;
  /** Optional project description. */
  description?: string;
  /** Author names or named author metadata. */
  authors: (string | { name: string; logo?: string })[];
  /** Arbitrary pack IDs mapped to source directories relative to config.json. */
  packs: Record<string, string>;
  /** Builder-specific format, reusable plugin definitions and named profiles. */
  bedrockCore: {
    formatVersion: '1.0.0';
    plugins?: Record<string, PluginDefinition>;
    /** Literal project-relative paths omitted from staging and watch mode. */
    staging?: { exclude?: string[] };
    profiles: Record<string, BuildProfile>;
  };
  [key: string]: unknown;
}

/** JSON Schema used by validation and exported for editor integrations. */
export const configSchema = JSON.parse(
  readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'),
);
const bundlerSchema = JSON.parse(
  readFileSync(new URL('../schemas/bundler.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });

ajv.addSchema(bundlerSchema, 'bundler.schema.json');
ajv.addSchema(JSON.parse(readFileSync(new URL('../schemas/manifest.schema.json', import.meta.url), 'utf8')), 'manifest.schema.json');
ajv.addSchema(JSON.parse(readFileSync(new URL('../schemas/generator.schema.json', import.meta.url), 'utf8')), 'generator.schema.json');
ajv.addSchema(JSON.parse(readFileSync(new URL('../schemas/guides.schema.json', import.meta.url), 'utf8')), 'guides.schema.json');
ajv.addSchema(JSON.parse(readFileSync(new URL('../schemas/i18n.schema.json', import.meta.url), 'utf8')), 'i18n.schema.json');
ajv.addSchema(JSON.parse(readFileSync(new URL('../schemas/ui-compiler.schema.json', import.meta.url), 'utf8')), 'ui-compiler.schema.json');
ajv.addSchema(configSchema, 'config.schema.json');
const validate = ajv.compile<ProjectConfig>({ $ref: 'config.schema.json' });
const validatePlugin = ajv.compile<PluginDefinition>({ $ref: 'config.schema.json#/definitions/plugin' });

/**
 * Validate a named entry without importing or executing its code.
 * @param definition Untrusted named plugin configuration.
 * @param name Plugin name included in validation diagnostics.
 * @returns The original definition without inserted defaults.
 * @throws If the definition does not match the plugin schema.
 */
export function validatePluginDefinition(definition: unknown, name: string): PluginDefinition {
  if (!validatePlugin(definition)) {
    throw new Error(`Invalid plugin definition: ${name}: ${ajv.errorsText(validatePlugin.errors)}`);
  }

  return definition;
}

/**
 * Validate without adding defaults or removing other tools' configuration.
 * @param config Project configuration; paths remain relative to its containing project.
 * @returns The original configuration typed as ProjectConfig.
 * @remarks Validation preserves unrelated metadata/tool namespaces and does not insert defaults. Plugin references and hook availability are checked by planBuild.
 * @throws If metadata or builder fields fail schema validation.
 */
export function validateConfig(config: unknown): ProjectConfig {
  if (!validate(config)) {
    const details = (validate.errors ?? [])
      .map(error => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');

    throw new Error(`Invalid project configuration: ${details}`);
  }

  return config;
}
