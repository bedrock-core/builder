import { implementationFile } from '../implementation.ts';
import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BuildContext, BuildStepResult } from '../contract.d.ts';
import { compilerVersion } from '@bedrock-core/builder-bundler';
import { generatedAliases } from '../imports.ts';
import { templateFiles } from '../template-files.ts';
import { buildCache } from '../file-cache.ts';
import { compileModule } from '../compile.ts';
import { generateTemplates, generateSchemaTypes, type JsonFormatting, type SchemaTypeSettings } from '@bedrock-core/builder-generator';

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
export async function run(context: BuildContext, settings: GeneratorSettings): Promise<BuildStepResult> {
  if (settings.types !== false) {
    await generateSchemaTypes({ ...settings, root: context.projectRoot, signal: context.signal, log: message => context.logger.info?.(`@bedrock-core/generator: ${message}`) });
  }

  const files = await templateFiles(context, settings);

  const aliases = generatedAliases(context, settings.generatedImports);
  const version = createHash('sha256');

  for (const file of [import.meta.url, '@bedrock-core/builder-generator', '@bedrock-core/builder-generator/internal/category',
    '@bedrock-core/builder-generator/internal/deterministic', '@bedrock-core/builder-bundler', '@bedrock-core/builder-bundler/internal/dependencies']) {
    version.update(await readFile(implementationFile(file, import.meta.url)));
  }

  const implementation = version.digest('hex');
  let cached = 0;
  let compiled = 0;
  let modulesReused = 0;
  const result = await generateTemplates({
    root: context.stagedRoot,
    files,
    dependencyRoot: context.projectRoot,
    aliases,
    tsconfig: settings.tsconfig,
    pretty: settings.pretty,
    signal: context.signal,
    async compile(options) {
      const result = await compileModule(context, options);

      if (result.cached) {
        modulesReused++;
      } else {
        compiled++;
      }

      return result;
    },
    async reuse(source, evaluate) {
      const output = await buildCache(context).reuse(projectPath(context.stagedRoot, source), {
        inputs: [source],
        key: {
          implementation,
          compilerVersion,
          nodePath: process.env.NODE_PATH ?? '',
          pretty: settings.pretty ?? false,
          tsconfig: settings.tsconfig ?? null,
          aliases: Object.fromEntries(Object.entries(aliases).map(([name, file]) => [name, path.relative(context.stagedRoot, file)])),
        },
        async run() {
          const result = await evaluate();

          return {
            value: {
              documents: result.documents.map(document => ({
                path: path.relative(context.stagedRoot, document.path),
                source: path.relative(context.stagedRoot, document.source),
                content: document.content,
                ...(document.category ? { category: document.category } : {}),
              })),
              inputs: result.inputs.map(file => path.relative(context.stagedRoot, file)),
              watchFiles: result.watchFiles.map(file => path.relative(context.stagedRoot, file)),
            },
            inputs: [...result.inputs, ...result.watchFiles],
            cache: result.cacheable,
          };
        },
      });

      if (output.cached) {
        cached++;
      }

      return {
        documents: output.value.documents.map(document => ({
          ...document,
          path: path.resolve(context.stagedRoot, document.path),
          source: path.resolve(context.stagedRoot, document.source),
          value: JSON.parse(document.content),
        })),
        inputs: output.value.inputs.map(file => path.resolve(context.stagedRoot, file)),
        watchFiles: output.value.watchFiles.map(file => path.resolve(context.stagedRoot, file)),
        cacheable: true,
      };
    },
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

  return {
    cached: cached === files.length,
    reason: `${compiled} compiled, ${modulesReused} compiled modules reused; ${files.length - cached} evaluated, ${cached} outputs reused`,
  };
}
