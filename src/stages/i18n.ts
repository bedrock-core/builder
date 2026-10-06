import path from 'node:path';
import { compileI18n, type I18nSettings, type TranslationPack } from '../../packages/i18n/src/index.ts';
import type { BuildContext } from '../contract.d.ts';
import { generatedAliases } from '../imports.ts';
import { compileModule } from '../compile.ts';

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Compile staged resources and register the runtime bundle for explicit downstream imports. */
export async function run(context: BuildContext, settings: I18nSettings): Promise<void> {
  const sourceDir = path.resolve(context.stagedRoot, settings.sourceDir ?? 'i18n');

  if (!within(context.stagedRoot, sourceDir)) {
    throw new Error('i18n sourceDir must be a directory inside the project');
  }

  const packs: TranslationPack[] = [];

  for (const id of Object.keys(context.packs)) {
    const pack = await context.inspectPack(id);

    if (pack.kind !== 'other') {
      packs.push({ path: pack.path, kind: pack.kind });
    }
  }

  const result = await compileI18n({
    ...settings,
    root: context.stagedRoot,
    namespace: settings.namespace ?? context.namespace,
    packs,
    dependencyRoot: context.projectRoot,
    aliases: generatedAliases(context),
    declarationRoot: context.projectRoot,
    outputDir: path.join(context.generatedDir, 'i18n'),
    typesDir: path.join(context.projectRoot, '.bedrock-core/generated/i18n'),
    cacheDir: path.join(context.projectRoot, '.bedrock-core/cache/i18n'),
    signal: context.signal,
    compile: options => compileModule(context, options),
    warn: message => context.logger.warn?.(`@bedrock-core/i18n: ${message}`),
  });

  for (const input of result.inputs) {
    if (within(context.stagedRoot, input)) {
      context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, input)));
    } else if (!within(context.generatedDir, input)) {
      context.registerDependency(input);
    }
  }

  if (result.bundlePath) {
    await context.registerArtifact('i18n:bundle', result.bundlePath, { importAs: '@bedrock-core/generated/i18n' });
  }

  for (const file of result.files) {
    const pack = Object.entries(context.packs).find(([, directory]) => within(directory, file));

    if (pack) {
      const relative = path.relative(pack[1], file).replaceAll('\\', '/');

      await context.registerArtifact(`i18n:${pack[0]}:${relative}`, file);
    }
  }
}
