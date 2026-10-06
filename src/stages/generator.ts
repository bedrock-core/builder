import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext } from '../contract.d.ts';
import { generatedAliases } from '../imports.ts';
import { templateFiles } from '../template-files.ts';
import { generateTemplates, generateSchemaTypes, type JsonFormatting, type SchemaTypeSettings } from '../../packages/generator/src/index.ts';

export interface GeneratorSettings extends SchemaTypeSettings {
  include?: string | string[];
  exclude?: string | string[];
  pretty?: JsonFormatting | false;
  tsconfig?: string;
  generatedImports?: Record<string, string>;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function projectPath(root: string, file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}

/** Discover templates only in configured packs and register their emitted JSON. */
export async function run(context: BuildContext, settings: GeneratorSettings): Promise<void> {
  if (settings.types !== false) {
    await generateSchemaTypes({ ...settings, root: context.projectRoot, signal: context.signal, log: message => context.logger.info?.(`@bedrock-core/generator: ${message}`) });
  }

  const files = await templateFiles(context, settings);

  const aliases = generatedAliases(context, settings.generatedImports);
  const result = await generateTemplates({
    root: context.stagedRoot,
    files,
    dependencyRoot: context.projectRoot,
    aliases,
    tsconfig: settings.tsconfig,
    pretty: settings.pretty,
    signal: context.signal,
  });

  for (const input of result.inputs) {
    if (within(context.stagedRoot, input)) {
      context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, input)));
    } else if (!within(context.generatedDir, input)) {
      context.registerDependency(input);
    }
  }

  for (const document of result.documents) {
    const pack = Object.entries(context.packs).find(([, directory]) => within(directory, document.path))!;
    const relative = projectPath(pack[1], document.path);

    await context.registerArtifact(`generator:${pack[0]}:${relative}`, document.path);
  }

  for (const template of result.templates) {
    await unlink(template);
  }
}
