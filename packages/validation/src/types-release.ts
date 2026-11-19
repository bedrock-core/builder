import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { version } from 'typescript-native';
import type { API } from 'typescript-native/sync';
import { createDocumentChecker, declaredCategories, documentCategory, documentLiteral } from './document-types.ts';

export { API } from 'typescript-native/sync';

const packageName = '@bedrock-core/bedrock-types';

export interface TypeSelection {
  /** Project directory from which to resolve its installed Bedrock types. */
  projectRoot?: string;
  /** Bedrock release track required from the installed types. */
  targetVersion?: string;
  /** Explicit installed types package directory, relative to the project or absolute. */
  typesRoot?: string;
}

export const checkerVersion = version;
export const typeImplementation = [
  new URL(import.meta.url),
  new URL('./document-types' + path.extname(new URL(import.meta.url).pathname), import.meta.url),
];

function track(version: string): string {
  return version.replace(/^1\./, '').split(/[.-]/).slice(0, 2).join('.');
}

function resolvePackage(require: NodeJS.Require): string | undefined {
  try {
    return require.resolve(packageName + '/package.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
}

async function declarationInputs(directory: string): Promise<string[]> {
  const inputs: string[] = [];

  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      inputs.push(...await declarationInputs(file));
    } else if (entry.name.endsWith('.d.ts') || entry.name === 'package.json') {
      inputs.push(file);
    }
  }

  return inputs;
}

export async function openTypesRelease(api: API, { projectRoot, targetVersion, typesRoot }: TypeSelection) {
  const project = path.resolve(projectRoot ?? process.cwd());
  const manifests = typesRoot
    ? [path.resolve(project, typesRoot, 'package.json')]
    : [resolvePackage(createRequire(path.join(project, 'package.json'))), resolvePackage(createRequire(import.meta.url))];
  const versions: string[] = [];

  for (const manifest of new Set(manifests)) {
    if (!manifest) {
      continue;
    }

    const metadata = JSON.parse(await readFile(manifest, 'utf8')) as { name: string; version: string };

    if (metadata.name !== packageName || typeof metadata.version !== 'string') {
      throw new Error('Invalid Bedrock types package metadata in ' + manifest);
    }

    versions.push(metadata.version);

    if (targetVersion && track(metadata.version) !== track(targetVersion)) {
      continue;
    }

    const distribution = path.join(path.dirname(manifest), 'dist');
    const categories = declaredCategories(api, path.join(distribution, 'documents.d.ts'));
    const inputs = [manifest, ...await declarationInputs(distribution)];

    return {
      version: metadata.version,
      inputs,
      category(kind: 'behavior' | 'resource' | 'other', file: string): string | undefined {
        if (kind !== 'other') {
          const category = documentCategory(kind, file);

          return categories.has(category) ? category : undefined;
        }
      },
      check: createDocumentChecker(api, distribution),
      literal: documentLiteral,
    };
  }

  const target = targetVersion ? ' for Bedrock ' + targetVersion : '';
  const installed = versions.length ? ` Found ${versions.join(', ')}.` : '';

  throw new Error(`Install a matching ${packageName} release${target}.${installed}`);
}
