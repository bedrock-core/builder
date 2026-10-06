import fs from 'node:fs';
import path from 'node:path';

export const LOCALE_FILE_RE = /^([a-z]{2}_[A-Z]{2})\.(?:ts|js|mts|mjs)$/;

export interface I18nLib {
  name: string;
  namespace: string;
  dir: string;
  pkgDir: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resolvePackageDir(start: string, name: string): string | undefined {
  let directory = start;

  for (;;) {
    const candidate = path.join(directory, 'node_modules', name);

    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

/** Traverse installed dependencies, including root devDependencies and non-declaring packages. */
export function discoverI18nLibs(projectRoot: string, inputs: Set<string>): I18nLib[] {
  const seen = new Set<string>();
  const libs: I18nLib[] = [];

  function readPackage(directory: string): Record<string, unknown> {
    const file = path.join(directory, 'package.json');

    inputs.add(file);

    if (!fs.existsSync(file)) {
      return {};
    }

    return object(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  function visit(directory: string, pkg: Record<string, unknown>, root = false): void {
    const names = [...new Set([
      ...Object.keys(object(pkg.dependencies)),
      ...Object.keys(root ? object(pkg.devDependencies) : {}),
    ])].sort();

    for (const name of names) {
      const pkgDir = resolvePackageDir(directory, name);

      if (!pkgDir) {
        continue;
      }

      const real = fs.realpathSync(pkgDir);

      if (seen.has(real)) {
        continue;
      }

      seen.add(real);
      const libPkg = readPackage(pkgDir);
      const declaration = object(libPkg.bedrockCore).i18n;

      if (declaration !== undefined) {
        const settings = object(declaration);

        if (typeof settings.dir !== 'string' || typeof settings.namespace !== 'string') {
          throw new Error(`${name}: bedrockCore.i18n must be an object { dir, namespace }`);
        }

        if (!/^[a-z0-9_]+$/.test(settings.namespace) || settings.namespace === 'vanilla') {
          throw new Error(`${name}: library namespace must be lowercase a-z0-9_ and cannot be vanilla`);
        }

        const dir = path.resolve(pkgDir, settings.dir);

        inputs.add(dir);
        libs.push({ name, namespace: settings.namespace, dir, pkgDir });
      }

      visit(pkgDir, libPkg);
    }
  }

  visit(projectRoot, readPackage(projectRoot), true);

  return libs.sort((a, b) => a.name.localeCompare(b.name));
}

export function localeFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();

  if (!fs.existsSync(directory)) {
    return files;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = LOCALE_FILE_RE.exec(entry.name);

    if (!match || !entry.isFile()) {
      continue;
    }

    if (files.has(match[1])) {
      throw new Error(`More than one resource module defines locale ${match[1]} in ${directory}`);
    }

    files.set(match[1], path.join(directory, entry.name));
  }

  return files;
}
