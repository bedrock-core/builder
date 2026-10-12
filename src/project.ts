import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectMetadata, BuildContext } from '@bedrock-core/builder-plugin';
import type { ProjectConfig } from './config.ts';
import { isManifestVersion } from '@bedrock-core/builder-manifest';

/** Resolve shared display and package metadata without importing project code. */
export async function resolveProject(config: ProjectConfig, root: string): Promise<ProjectMetadata> {
  let pkg: { name?: string; version?: string } = {};

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

  return Object.freeze({
    namespace: config.namespace,
    name: config.name,
    description: config.description ?? '',
    authors: Object.freeze(config.authors.map(author => typeof author === 'string' ? author : author.name)),
    targetVersion: config.targetVersion,
    ...(pkg.name ? { packageName: pkg.name } : {}),
    ...(pkg.version ? { version: pkg.version } : {}),
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
