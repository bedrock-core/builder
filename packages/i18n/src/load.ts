import { bundleScripts } from '@bedrock-core/builder-bundler';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { I18nOptions } from './types.ts';

/** A fresh output path per build reevaluates resources and their imported helpers. */
export async function loadResources(file: string, output: string, options: I18nOptions, inputs: Set<string>): Promise<unknown> {
  const result = await bundleScripts({
    root: path.resolve(options.root),
    entry: file,
    outfile: output,
    dependencyRoot: options.dependencyRoot,
    aliases: options.aliases,
    tsconfig: options.tsconfig,
    platform: 'node',
    debug: true,
    target: 'esnext',
    signal: options.signal,
    banner: 'import { createRequire as __bedrockCoreCreateRequire } from \'node:module\'; const require = __bedrockCoreCreateRequire(import.meta.url);',
  });

  for (const input of result.inputs) {
    inputs.add(input);
  }

  const module: Record<string, unknown> = await import(pathToFileURL(output).href);

  options.signal?.throwIfAborted();

  if (!Object.hasOwn(module, 'default')) {
    throw new Error(`${file} must default-export a nested object of strings`);
  }

  return module.default;
}
