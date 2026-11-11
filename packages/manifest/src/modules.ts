import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isManifestVersion, type JsonObject } from './index.ts';
import { apiPackageMetadata } from './api-package.ts';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(exportTarget).find(value => value !== undefined);
  }

  if (record(value)) {
    for (const condition of ['import', 'default', 'require', 'types']) {
      const selected = exportTarget(value[condition]);

      if (selected !== undefined) {
        return selected;
      }
    }
  }
}

/** Resolve the exported manifest of the script pack that owns a public module entry. */
export function moduleManifestPath(root: string, metadata: Record<string, unknown>, specifier: string, register?: (file: string) => void): string {
  const name = String(metadata.name);
  const suffix = specifier.split('/').slice(specifier.startsWith('@') ? 2 : 1).join('/');
  const subpath = suffix ? `./${suffix}` : '.';
  const exports = record(metadata.exports) ? metadata.exports : metadata.exports === undefined ? { './manifest.json': './manifest.json' } : {};

  const inside = (file: string): boolean => {
    const relative = path.relative(root, file);

    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  const resolve = (value: unknown, label: string): string | undefined => {
    const target = exportTarget(value);

    if (target === undefined) {
      return;
    }

    if (!target.startsWith('./') || !inside(path.resolve(root, target))) {
      throw new Error(`Public export ${label} must stay inside ${name}`);
    }

    const file = path.resolve(root, target);
    const stem = /\.[cm]?jsx?$/.test(file) ? file.replace(/\.[cm]?jsx?$/, '') : file;

    for (const candidate of [file, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, path.join(file, 'index.ts'), path.join(file, 'index.js')]) {
      register?.(candidate);

      if (!existsSync(candidate) || !statSync(candidate).isFile()) {
        continue;
      }

      const physical = realpathSync(candidate);

      register?.(physical);

      if (!inside(physical)) {
        throw new Error(`Public export ${label} must stay inside ${name}`);
      }

      return physical;
    }

    throw new Error(`Public export ${label} does not exist: ${file}`);
  };

  const published = apiPackageMetadata(metadata);

  if (published) {
    if (!Object.hasOwn(exports, subpath) || !Object.hasOwn(published.manifests, subpath)) {
      throw new Error(`Published API ${specifier} needs an explicit export and owner manifest mapping`);
    }

    return resolve(published.manifests[subpath], subpath)!;
  }

  const manifests = [...new Set(Object.entries(exports).filter(([key]) => key === './manifest.json' || key.endsWith('/manifest.json'))
    .map(([key, value]) => resolve(value, key)).filter((file): file is string => file !== undefined))];

  if (!manifests.length) {
    throw new Error(`Addon package ${name} must expose ./manifest.json`);
  }

  const source = resolve(exports[subpath], subpath);

  if (source === undefined) {
    if (subpath !== '.') {
      throw new Error(`Addon package ${name} must expose public entry ${subpath}`);
    }

    const primary = resolve(exports['./manifest.json'], './manifest.json');

    if (primary !== undefined) {
      return primary;
    }

    throw new Error(`Addon package ${name} must expose ./manifest.json`);
  }

  if (manifests.includes(source)) {
    return source;
  }

  let directory = path.dirname(source);

  while (inside(directory)) {
    const selected = manifests.filter(file => path.dirname(file) === directory);
    const boundary = path.join(directory, 'manifest.json');

    register?.(boundary);

    if (selected.length === 1) {
      return selected[0];
    }

    if (selected.length > 1) {
      throw new Error(`Public entry ${specifier} has ambiguous exported manifests in ${directory}`);
    }

    if (existsSync(boundary)) {
      throw new Error(`Public entry ${specifier} must export its owning pack manifest from ${directory}`);
    }

    if (directory === root) {
      break;
    }

    directory = path.dirname(directory);
  }

  throw new Error(`Public API ${specifier} must be inside a pack with an exported manifest`);
}

/** Resolve API versions or an addon package's exported JSON without evaluating module code. */
export function resolveModuleDependency(dependency: JsonObject, options: { dependencyRoot?: string; registerDependency?: (file: string) => void }, merge: (parent: JsonObject, child: JsonObject) => JsonObject): JsonObject {
  const name = dependency.module_name;

  const baseName = typeof name === 'string' ? name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/') : '';
  const suffix = typeof name === 'string' ? name.slice(baseName.length) : '';

  if (typeof name !== 'string' || !packageName.test(baseName) || (suffix !== '' && (!/^\/[a-z0-9_./-]+$/i.test(suffix) || suffix.slice(1).split('/').some(part => !part || part === '.' || part === '..')))) {
    throw new Error(`Invalid module dependency ${String(name)}; use an installed npm package name`);
  }

  const nativeApi = (moduleName: string, inferred: unknown): JsonObject => {
    if (dependency.namespace !== undefined) {
      throw new Error(`Minecraft API module ${moduleName} cannot declare a Core namespace`);
    }

    const version = dependency.version !== undefined ? dependency.version : inferred;

    if (!isManifestVersion(version)) {
      throw new Error(`Module ${moduleName} has an invalid package.version; expected a semantic version`);
    }

    const beta = dependency.version === undefined
      ? /^(\d+\.\d+\.\d+-beta)\.\d+\.\d+\.\d+-(?:stable|preview)(?:\.\d+)?$/.exec(version)
      : null;

    return { module_name: moduleName, version: beta?.[1] ?? version };
  };

  if (baseName.startsWith('@minecraft/') && suffix !== '') {
    throw new Error(`Minecraft API module ${name} must use its package name`);
  }

  if (name.startsWith('@minecraft/') && dependency.version !== undefined) {
    return nativeApi(name, undefined);
  }

  if (!options.dependencyRoot) {
    throw new Error(`Module ${name} needs a project dependencyRoot to resolve its installed package`);
  }

  const root = path.resolve(options.dependencyRoot);
  const require = createRequire(path.join(root, 'package.json'));
  const candidates = (require.resolve.paths(baseName) ?? []).map(directory => path.join(directory, baseName, 'package.json'));

  options.registerDependency?.(path.join(root, 'package.json'));

  try {
    const resolved = require.resolve(`${baseName}/package.json`);

    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  } catch (error) {
    if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  }

  for (const file of candidates) {
    options.registerDependency?.(file);
    let actual: string;

    try {
      actual = realpathSync(file);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        continue;
      }

      throw error;
    }

    options.registerDependency?.(actual);
    let metadata: JsonObject;

    try {
      const value: unknown = JSON.parse(readFileSync(actual, 'utf8'));

      if (!record(value)) {
        throw new Error('package.json must contain an object');
      }

      metadata = value;
    } catch (error) {
      throw new Error(`Module ${name} has invalid package metadata in ${actual}`, { cause: error });
    }

    const moduleName = metadata.name === undefined ? baseName : metadata.name;

    if (typeof moduleName !== 'string' || !packageName.test(moduleName)) {
      throw new Error(`Module ${name} has an invalid package.name in ${actual}`);
    }

    if (moduleName.startsWith('@minecraft/')) {
      return nativeApi(moduleName, metadata.version);
    }

    const packageRoot = path.dirname(actual);
    const exported = moduleManifestPath(packageRoot, { ...metadata, name: moduleName }, name, options.registerDependency);
    const authoredRoot = path.dirname(file);

    const inside = (base: string, target: string): boolean => {
      const relative = path.relative(base, target);

      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };

    const read = (source: string, ancestors: readonly string[]): JsonObject => {
      const absolute = path.resolve(source);

      if (!inside(packageRoot, absolute) && !inside(authoredRoot, absolute)) {
        throw new Error(`Addon package ${name} manifest must stay inside its package: ${absolute}`);
      }

      options.registerDependency?.(absolute);
      const physical = realpathSync(absolute);

      options.registerDependency?.(physical);

      if (!inside(packageRoot, physical)) {
        throw new Error(`Addon package ${name} manifest must stay inside its package: ${physical}`);
      }

      if (ancestors.includes(physical)) {
        throw new Error(`Circular extends chain in addon package ${name}: ${physical}`);
      }

      const value: unknown = JSON.parse(readFileSync(physical, 'utf8'));

      if (!record(value)) {
        throw new Error(`Addon package ${name} manifest must contain an object: ${physical}`);
      }

      const parent = value.extends;

      delete value.extends;

      if (parent === undefined) {
        return value;
      }

      if (typeof parent !== 'string' || !/^\.\.?[\\/]/.test(parent)) {
        throw new Error(`Addon package ${name} manifest extends must use a relative path`);
      }

      return merge(read(path.resolve(path.dirname(physical), parent), [...ancestors, physical]), value);
    };

    const manifest = read(path.join(authoredRoot, path.relative(packageRoot, exported)), []);
    const header = manifest.header;

    if (!record(header) || typeof header.uuid !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(header.uuid)) {
      throw new Error(`Addon package ${name} manifest needs a valid header.uuid`);
    }

    const version = dependency.version !== undefined ? dependency.version : header.version !== undefined ? header.version : metadata.version;

    if (!isManifestVersion(version)) {
      throw new Error(`Addon package ${name} needs a semantic dependency version, manifest header.version or package.version`);
    }

    const scripted = Array.isArray(manifest.modules) && manifest.modules.some(module => record(module) && module.type === 'script');
    const namespace = scripted ? manifest.namespace : undefined;

    if (namespace !== undefined && (typeof namespace !== 'string' || !/^[a-z0-9_]+$/.test(namespace) || namespace === 'minecraft')) {
      throw new Error(`Addon package ${name} manifest has an invalid Core namespace`);
    }

    if (dependency.namespace !== undefined && dependency.namespace !== namespace) {
      throw new Error(`Addon package ${name} does not declare the requested scripted Core namespace ${String(dependency.namespace)}`);
    }

    return { uuid: header.uuid, version, ...(namespace === undefined ? {} : { namespace }) };
  }

  throw new Error(`Module ${name} is not installed for ${root}; install its addon package or author an explicit Minecraft API version`);
}
