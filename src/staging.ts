import path from 'node:path';
import type { ProjectConfig } from './config.ts';

const contains = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

/** Literal project paths omitted from staging and project watches. */
export function stagingExclusions(project: string, config: ProjectConfig, configPath = path.join(project, 'config.json')): string[] {
  const packs = Object.values(config.packs).map(directory => path.resolve(project, directory));
  const result = new Set<string>();

  for (const source of config.bedrockCore.staging?.exclude ?? []) {
    if (path.isAbsolute(source) || path.win32.isAbsolute(source) || /^[A-Za-z]:/.test(source) || /[*?\0]/.test(source)) {
      throw new Error('Staging exclusions must be literal project-relative paths: ' + source);
    }

    const file = path.resolve(project, source.replaceAll('\\', '/'));

    if (!contains(project, file) || path.relative(project, file) === '') {
      throw new Error('Staging exclusions must stay inside the project: ' + source);
    }

    if (contains(file, configPath) || packs.some(pack => contains(file, pack))) {
      throw new Error('Staging exclusions cannot omit the configuration or a pack source: ' + source);
    }

    result.add(file);
  }

  return [...result];
}

export const isStagingExcluded = (file: string, exclusions: readonly string[]): boolean =>
  exclusions.some(directory => contains(directory, file));
