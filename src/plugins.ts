import type { BuildContext, BuildPlugin, BuildStepResult } from '@bedrock-core/builder-plugin';

/** Load and validate a native module through the common plugin contract. */
export async function loadPlugin(url: string, name: string): Promise<BuildPlugin> {
  const plugin = await import(url);

  if (typeof plugin.run !== 'function') {
    throw new Error(`Plugin must export run(context, settings): ${name}`);
  }

  if (plugin.detect !== undefined && typeof plugin.detect !== 'function') {
    throw new Error(`Plugin detect must be a function: ${name}`);
  }

  if (plugin.inputDirectories !== undefined && typeof plugin.inputDirectories !== 'function') {
    throw new Error(`Plugin inputDirectories must be a function: ${name}`);
  }

  return plugin;
}

/** Execute built-in or external plugin code, applying its optional auto detector. */
export async function executePlugin(
  plugin: BuildPlugin,
  context: BuildContext,
  settings: Record<string, unknown>,
  mode: 'auto' | 'always' = 'always',
): Promise<{ status: 'executed' | 'skipped' | 'cached'; reason?: string }> {
  context.signal?.throwIfAborted();
  const detection = mode === 'auto' ? await plugin.detect?.(context, settings) : undefined;

  if (mode === 'auto' && plugin.detect && (!detection || typeof detection.needed !== 'boolean' || typeof detection.reason !== 'string')) {
    throw new Error('Plugin detect must return { needed: boolean, reason: string }');
  }

  context.signal?.throwIfAborted();

  if (detection && !detection.needed) {
    return { status: 'skipped', reason: detection.reason };
  }

  context.signal?.throwIfAborted();
  const result: BuildStepResult | void = await plugin.run(context, settings);

  return { status: result?.cached ? 'cached' : 'executed', reason: result?.reason ?? detection?.reason };
}
