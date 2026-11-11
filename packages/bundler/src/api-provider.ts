import path from 'node:path';
import type { ApiModule } from './api.ts';
import { apiShapeSource } from './api-source.ts';

/** Describe exported implementations before their owning entry calls core.register(). */
export function apiProvider(modules: readonly ApiModule[], projectRoot: string, stagedRoot: string): {
  has(file: string): boolean;
  transform(file: string, contents: string): string;
} {
  const staged = (file: string): string => {
    const relative = path.relative(projectRoot, file);

    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      ? path.join(stagedRoot, relative)
      : file;
  };

  const sources = new Map<string, ApiModule[]>();

  for (const module of modules) {
    const file = path.normalize(staged(module.source));
    const entries = sources.get(file) ?? [];

    entries.push(module);
    sources.set(file, entries);
  }

  return {
    has: file => sources.has(path.normalize(file)),
    transform(file, contents) {
      const entries = sources.get(path.normalize(file));

      if (!entries) {
        return contents;
      }

      let prefix = '__coreApi';

      while (contents.includes(prefix)) {
        prefix += '_';
      }

      const metadata = entries.flatMap((module, index) => {
        const shape = apiShapeSource(module.shape, staged, `${prefix}Values${index}_`);

        return [
          ...shape.imports,
          `import * as ${prefix}Exports${index} from ${JSON.stringify(file)};`,
          `${prefix}Define(${JSON.stringify(module.moduleName)}, ${shape.shape}, ${prefix}Exports${index});`,
        ];
      });

      return `${contents}\nimport { defineApiModule as ${prefix}Define } from '@bedrock-core/server-runtime/api';\n${metadata.join('\n')}`;
    },
  };
}
