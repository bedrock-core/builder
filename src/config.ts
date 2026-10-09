import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

export type StageName = 'manifest' | 'generator' | 'guides' | 'i18n' | 'ui-compiler' | 'bundler';
export type Settings = Record<string, unknown>;
export type StageSelection = 'auto' | boolean | Settings;
export type PluginTargets = 'resource' | 'behavior' | 'both';
export interface NodePluginDefinition {
  script: string;
  targets?: PluginTargets;
  filterDir?: string;
  dataPath?: string;
  packs?: { BP?: string; RP?: string };
  nodeArguments?: string[];
}
export type PluginDefinition = { module: string; targets?: PluginTargets } | NodePluginDefinition;
export type PluginStep = { plugin: string; settings?: Settings; arguments?: string[] } & (
  { before: StageName | 'export'; after?: never } | { after: StageName | 'prepare'; before?: never }
);
export interface BuildProfile {
  stages?: Partial<Record<StageName, StageSelection>>;
  cache?: boolean;
  steps?: PluginStep[];
  export?: Record<string, string>;
  watch?: { debounceMs?: number; paths?: string[] };
}
export interface ProjectConfig {
  $schema?: string;
  targetVersion: string;
  namespace: string;
  name: string;
  description?: string;
  authors: (string | { name: string; logo?: string })[];
  packs: Record<string, string>;
  bedrockCore: {
    formatVersion: '1.0.0';
    plugins?: Record<string, PluginDefinition>;
    profiles: Record<string, BuildProfile>;
  };
  [key: string]: unknown;
}

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

/** Validate a named entry without importing or executing its code. */
export function validatePluginDefinition(definition: unknown, name: string): PluginDefinition {
  if (!validatePlugin(definition)) {
    throw new Error(`Invalid plugin definition: ${name}: ${ajv.errorsText(validatePlugin.errors)}`);
  }

  return definition;
}

/** Validate without adding defaults or removing other tools' configuration. */
export function validateConfig(config: unknown): ProjectConfig {
  if (!validate(config)) {
    const details = (validate.errors ?? [])
      .map(error => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');

    throw new Error(`Invalid project configuration: ${details}`);
  }

  return config;
}
