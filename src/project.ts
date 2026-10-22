import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectMetadata, BuildContext } from '@bedrock-core/builder-plugin';
import type { ProjectConfig } from './config.ts';
import { isManifestVersion } from '@bedrock-core/builder-manifest';

/** Resolve shared display and package metadata without importing project code. */
export async function resolveProject(config: ProjectConfig, root: string, dependency: (file: string) => void = () => {}): Promise<ProjectMetadata> {
  let pkg: { name?: string; version?: string; license?: unknown; homepage?: unknown; url?: unknown } = {};

  dependency(path.join(root, 'package.json'));

  try {
    pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)
    || (pkg.name !== undefined && (typeof pkg.name !== 'string' || !pkg.name.trim()))
    || (pkg.version !== undefined && !isManifestVersion(pkg.version))) {
    throw new Error('package.json must contain a valid package name and semantic version when provided');
  }

  let license = typeof pkg.license === 'string' && pkg.license.trim() ? pkg.license.trim() : undefined;
  const requestedLicense = license?.match(/^SEE LICENSE IN (.+)$/i)?.[1];
  const licenseFiles = requestedLicense
    ? [requestedLicense]
    : ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'LICENCE.txt', 'LICENCE.md', 'COPYING'];

  if (!license || requestedLicense) {
    for (const name of licenseFiles) {
      const file = path.resolve(root, name);

      if (path.dirname(file) !== path.resolve(root)) {
        throw new Error('The package license file must be in the project root');
      }

      dependency(file);

      try {
        const content = (await readFile(file, 'utf8')).trim();

        if (content) {
          license = content;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  if (requestedLicense && license?.match(/^SEE LICENSE IN /i)) {
    throw new Error(`The package license file is missing or empty: ${requestedLicense}`);
  }

  const url = [pkg.homepage, pkg.url].find((value): value is string => typeof value === 'string' && !!value.trim());

  return Object.freeze({
    namespace: config.namespace,
    name: config.name,
    description: config.description ?? '',
    authors: Object.freeze(config.authors.map(author => typeof author === 'string' ? author : author.name)),
    targetVersion: config.targetVersion,
    ...(pkg.name ? { packageName: pkg.name } : {}),
    ...(pkg.version ? { version: pkg.version } : {}),
    ...(license ? { license } : {}),
    ...(url ? { url: url.trim() } : {}),
  });
}

/** Emit shared project metadata and literal editor declarations. */
export async function generateProject(context: BuildContext, project: ProjectMetadata): Promise<void> {
  const value = JSON.stringify(project);
  const file = path.join(context.generatedDir, 'project.js');
  const declarations = path.join(context.projectRoot, '.bedrock-core/generated/project.d.ts');

  await writeFile(file, `export const project = ${value};\n`);
  await mkdir(path.dirname(declarations), { recursive: true });
  await writeFile(declarations, `declare module '@bedrock-core/generated/project' {\n  export const project: ${value};\n}\n`);
  await context.registerArtifact('project:metadata', file, { importAs: '@bedrock-core/generated/project' });
}
