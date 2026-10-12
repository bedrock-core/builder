import { builtinPlugins } from './builtins.ts';
import { validatePluginDefinition, type NodePluginDefinition, type PluginTargets, type ProjectConfig, type StageName, type Settings } from './config.ts';
/** Ordered built-in boundaries; automatic input detection happens during execution. */
export const stages: readonly StageName[] = Object.freeze(Object.keys(builtinPlugins) as StageName[]);
/** Resolved plugin definition and invocation settings at one pipeline boundary. */
export type PlannedPlugin = {
  kind: 'plugin';
  plugin: string;
  settings: Settings;
  targets?: PluginTargets;
  scope?: 'pack' | 'project';
  mode?: 'auto' | 'always';
  position: 'before' | 'after';
  boundary: string;
} & ({ module: string; script?: never } | (NodePluginDefinition & { module?: never; arguments: string[] }));
/** Built-in or lifecycle operation in a resolved plan. */
export type PlannedStage = {
  kind: 'stage';
  stage: StageName | 'prepare' | 'validate' | 'export';
  settings?: Settings;
  mode?: 'auto' | 'always';
};
/** One operation in the sequential build plan. */
export type PlannedStep = PlannedPlugin | PlannedStage;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolve a deterministic execution plan without loading or executing plugin code.
 * @param config Project configuration; paths remain relative to its containing project.
 * @param profileName Named profile; defaults to default.
 * @returns Prepare, hooks, selected stages, validation and export in deterministic order.
 * @remarks Automatic stage boundaries are included; input detection happens during execution after before hooks. This operation does not import plugin code.
 * @throws If the profile, plugin reference or enabled hook boundary is invalid.
 */
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

    if (settings !== 'auto' && settings !== true && settings !== false && !record(settings)) {
      throw new Error(`Invalid stage settings: ${name}`);
    }
  }

  const enabled = stages.filter(name => selected[name] !== false);
  const defaults: Settings = {
    ...(profile.pretty === undefined ? {} : { pretty: profile.pretty }),
    ...(profile.debug === undefined ? {} : { debug: profile.debug }),
  };
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

    const position: PlannedPlugin['position'] = before ? 'before' : 'after';
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

    const entry = definitions[step.plugin];

    if (entry === undefined) {
      throw new Error(`Missing plugin definition: ${step.plugin}`);
    }

    const definition = validatePluginDefinition(entry, step.plugin);

    if (step.settings !== undefined && !record(step.settings)) {
      throw new Error(`Invalid plugin settings: ${step.plugin}`);
    }

    if (step.arguments !== undefined && (!Array.isArray(step.arguments) || !step.arguments.every(argument => typeof argument === 'string'))) {
      throw new Error(`Invalid plugin arguments: ${step.plugin}`);
    }

    if ('module' in definition && step.arguments !== undefined) {
      throw new Error(`Script arguments require a script plugin: ${step.plugin}`);
    }

    if (step.mode !== undefined && step.mode !== 'auto' && step.mode !== 'always') {
      throw new Error(`Invalid plugin mode: ${step.plugin}`);
    }

    if ('script' in definition && step.mode === 'auto') {
      throw new Error(`Automatic detection requires a module plugin: ${step.plugin}`);
    }

    const invocation = {
      kind: 'plugin' as const,
      plugin: step.plugin,
      settings: step.settings ?? {},
      ...(step.mode === undefined ? {} : { mode: step.mode as 'auto' | 'always' }),
      position,
      boundary: boundary!,
    };

    return 'module' in definition
      ? { ...invocation, ...definition }
      : { ...invocation, ...definition, arguments: step.arguments ?? [] };
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
        settings: { ...defaults, ...(record(selected[stage]) ? (selected[stage] as Settings) : {}) },
        mode: selected[stage] === true || record(selected[stage]) ? 'always' : 'auto',
      },
      ...at('after', stage),
    ]),
    ...at('before', 'export'),
    { kind: 'stage', stage: 'validate' },
    { kind: 'stage', stage: 'export' },
  ];
}
