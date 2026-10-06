import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

export type StageName = 'manifest' | 'generator' | 'guides' | 'i18n' | 'ui-compiler' | 'bundler';
export type Settings = Record<string, unknown>;
export type PluginStep = { plugin: string; settings?: Settings } & (
  { before: StageName | 'export'; after?: never } | { after: StageName | 'prepare'; before?: never }
);
export interface BuildProfile {
  stages?: Partial<Record<StageName, boolean | Settings>>;
  steps?: PluginStep[];
  export?: { target?: 'local'; path: string };
}
export interface ProjectConfig {
  type: 'minecraftBedrock';
  name: string;
  authors: (string | { name: string; logo?: string })[];
  targetVersion: string;
  namespace: string;
  worlds: string[];
  packs: Record<string, string>;
  bedrockCore: {
    formatVersion: '1.0.0';
    plugins?: Record<string, { module: string }>;
    profiles: Record<string, BuildProfile>;
  };
  [key: string]: unknown;
}

export const configSchema = JSON.parse(
  readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'),
);
const bundlerSchema = JSON.parse(
  readFileSync(new URL('../packages/bundler/schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });

ajv.addSchema(bundlerSchema, 'packages/bundler/schema.json');
const validate = ajv.compile<ProjectConfig>(configSchema);

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
