import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveNamespace, type ProjectMetadata, type BuildContext } from '@bedrock-core/builder-plugin';
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
    namespace: resolveNamespace(config.namespace, config.bedrockCore.addon),
    name: config.name,
    description: config.description ?? '',
    authors: Object.freeze(config.authors.map(author => typeof author === 'string' ? author : author.name)),
    targetVersion: config.targetVersion,
    ...(pkg.name ? { packageName: pkg.name } : {}),
    ...(pkg.version ? { version: pkg.version } : {}),
    ...(config.bedrockCore.addon ? { addon: Object.freeze({ ...config.bedrockCore.addon }) } : {}),
  });
}

/** Emit runtime metadata and literal editor declarations; registration remains explicit. */
export async function generateProject(context: BuildContext, project: ProjectMetadata): Promise<void> {
  const addonManifest = project.addon && {
    ...project.addon,
    packName: project.name,
    creatorName: project.authors.join(', '),
    description: project.description,
    version: project.version,
  };

  if (addonManifest && !project.version) {
    throw new Error('Addon registration metadata needs a version in package.json');
  }

  const values = { project, ...(addonManifest ? { addonManifest } : {}) };
  const file = path.join(context.generatedDir, 'project.js');
  const declarations = path.join(context.projectRoot, '.bedrock-core/generated/project.d.ts');

  await writeFile(file, Object.entries(values).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n'));
  await mkdir(path.dirname(declarations), { recursive: true });
  await writeFile(declarations, `declare module '@bedrock-core/generated/project' {\n${Object.entries(values).map(([name, value]) => `  export const ${name}: ${JSON.stringify(value)};`).join('\n')}\n}\n`);
  await context.registerArtifact('project:metadata', file, { importAs: '@bedrock-core/generated/project' });
}
