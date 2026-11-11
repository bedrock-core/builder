import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readdir, symlink } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AcceptanceDependencies {
  readonly root: string;
  readonly modules: string;
}

function metadata(root: string, name: string): string | undefined {
  try {
    const file = findPackageJSON(name, pathToFileURL(path.join(root, 'package.json')));

    if (!file) {
      return undefined;
    }

    const relative = path.relative(path.join(root, 'node_modules'), file);

    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? undefined : file;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(String(error.code))) {
      return undefined;
    }

    throw error;
  }
}

/** Select fixture-installed dependencies or the explicitly supplied toolkit project. */
export function acceptanceDependencies(repository: string, fixture = 'acceptance', required?: readonly string[]): AcceptanceDependencies {
  const source = path.join(repository, 'fixtures', fixture);
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const names = required ?? Object.keys(manifest.dependencies ?? {});
  const requested = process.env.BUILDER_ACCEPTANCE_DEPENDENCY_ROOT;
  const candidates = requested ? [path.resolve(requested)] : [source, repository];

  for (const root of candidates) {
    const modules = path.join(root, 'node_modules');

    if (existsSync(modules) && names.every(name => metadata(root, name) !== undefined)) {
      return { root, modules };
    }
  }

  throw new Error(`Acceptance dependencies are missing for fixtures/${fixture}. Install that fixture's dependencies, or set BUILDER_ACCEPTANCE_DEPENDENCY_ROOT to a project containing matching installed dependencies: ${names.join(', ')}.`);
}

/** Resolve ESM-only packages without evaluating their Minecraft entry points. */
export function installedPackage(dependencies: AcceptanceDependencies, name: string): string {
  const file = metadata(dependencies.root, name);

  if (!file) {
    throw new Error(`Acceptance dependency is missing: ${name}`);
  }

  return realpathSync(path.dirname(file));
}

/** Preserve installed dependency identities while allowing selected packages to be copied. */
export async function linkAcceptanceDependencies(root: string, dependencies: AcceptanceDependencies, options: { exclude?: readonly string[] } = {}): Promise<void> {
  const excluded = new Set(options.exclude);

  const link = async (name: string): Promise<void> => {
    if (excluded.has(name)) {
      return;
    }

    const target = path.join(root, 'node_modules', name);

    await mkdir(path.dirname(target), { recursive: true });
    await symlink(realpathSync(path.join(dependencies.modules, name)), target, process.platform === 'win32' ? 'junction' : 'dir');
  };

  for (const entry of await readdir(dependencies.modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) {
      continue;
    }

    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path.join(dependencies.modules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) {
          await link(`${entry.name}/${child.name}`);
        }
      }
    } else {
      await link(entry.name);
    }
  }
}
