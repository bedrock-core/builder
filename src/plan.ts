/** Default ordering; profiles explicitly select the stages they need. */
import type { ProjectConfig, StageName, Settings } from './config.ts';
export const stages: readonly StageName[] = Object.freeze([
  'manifest',
  'generator',
  'guides',
  'i18n',
  'ui-compiler',
  'bundler',
]);
export type PlannedPlugin = {
  kind: 'plugin';
  plugin: string;
  module: string;
  settings: Settings;
  position: 'before' | 'after';
  boundary: string;
};
export type PlannedStage = {
  kind: 'stage';
  stage: StageName | 'prepare' | 'validate' | 'export';
  settings?: Settings;
};
export type PlannedStep = PlannedPlugin | PlannedStage;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolve a deterministic execution plan without loading or executing plugin code. */
export function planBuild(config: ProjectConfig, profileName = 'default'): PlannedStep[] {
  const tool = config?.bedrockCore;

  if (!record(tool) || tool.formatVersion !== '1.0.0') {
    throw new Error('Expected bedrockCore.formatVersion 1.0.0');
  }

  const profile = tool.profiles?.[profileName];

  if (!record(profile)) {
    throw new Error(`Unknown profile: ${profileName}`);
  }

  const selected = profile.stages ?? {};

  if (!record(selected)) {
    throw new Error('stages must be an object');
  }

  for (const [name, settings] of Object.entries(selected)) {
    if (!stages.some(stage => stage === name)) {
      throw new Error(`Unknown stage: ${name}`);
    }

    if (settings !== true && settings !== false && !record(settings)) {
      throw new Error(`Invalid stage settings: ${name}`);
    }
  }

  const enabled = stages.filter(
    name => Object.hasOwn(selected, name) && selected[name] !== false,
  );
  const definitions = tool.plugins ?? {};

  if (!record(definitions)) {
    throw new Error('plugins must be an object');
  }

  const steps = profile.steps ?? [];

  if (!Array.isArray(steps)) {
    throw new Error('steps must be an array');
  }

  const hooks: PlannedPlugin[] = steps.map((step, index) => {
    if (!record(step) || typeof step.plugin !== 'string') {
      throw new Error(`Invalid step: ${index}`);
    }

    const before = Object.hasOwn(step, 'before');
    const after = Object.hasOwn(step, 'after');

    if (before === after) {
      throw new Error(`Step ${index} needs exactly one before or after boundary`);
    }

    const position = before ? 'before' : 'after';
    const boundary = step[position];

    if (typeof boundary !== 'string') {
      throw new Error(`Invalid boundary: ${index}`);
    }

    if (
      !enabled.some(stage => stage === boundary)
      && !(position === 'after' && boundary === 'prepare')
      && !(position === 'before' && boundary === 'export')
    ) {
      throw new Error(`Unavailable boundary: ${position} ${boundary}`);
    }

    const definition = definitions[step.plugin];

    if (!record(definition) || typeof definition.module !== 'string' || !definition.module.trim()) {
      throw new Error(`Missing plugin module: ${step.plugin}`);
    }

    if (step.settings !== undefined && !record(step.settings)) {
      throw new Error(`Invalid plugin settings: ${step.plugin}`);
    }

    return {
      kind: 'plugin',
      plugin: step.plugin,
      module: definition.module,
      settings: step.settings ?? {},
      position,
      boundary: boundary!,
    };
  });
  const at = (position: 'before' | 'after', boundary: string) =>
    hooks.filter(step => step.position === position && step.boundary === boundary);

  return [
    { kind: 'stage', stage: 'prepare' },
    ...at('after', 'prepare'),
    ...enabled.flatMap<PlannedStep>(stage => [
      ...at('before', stage),
      {
        kind: 'stage',
        stage,
        settings: record(selected[stage]) ? (selected[stage] as Settings) : {},
      },
      ...at('after', stage),
    ]),
    ...at('before', 'export'),
    { kind: 'stage', stage: 'validate' },
    { kind: 'stage', stage: 'export' },
  ];
}
