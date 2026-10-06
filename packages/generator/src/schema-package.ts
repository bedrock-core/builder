import { mkdir, readFile, writeFile, stat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractTgz } from './tar.ts';

export const PACKAGE_NAME = '@minecraft/bedrock-schemas';
const REGISTRY = 'https://registry.npmjs.org';
const KEEP = [/^schemas\//, /^types\//, /^catalog\.json$/, /^package\.json$/, /^LICENSE$/];

interface RegistryMetadata {
  'dist-tags'?: Record<string, string>;
  'versions'?: Record<string, { dist: { tarball: string } }>;
}

export interface SchemaPackageOptions {
  version: string;
  cacheDir: string;
  maxAgeHours: number;
  signal?: AbortSignal;
  log: (message: string) => void;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return false;
  }
}

function versionFolder(version: string): string {
  if (!/^[\w][\w.-]*$/.test(version) || version.includes('..')) {
    throw new Error(`Invalid ${PACKAGE_NAME} version: ${version}`);
  }

  return version;
}

async function metadata(options: SchemaPackageOptions): Promise<RegistryMetadata> {
  const file = path.join(options.cacheDir, 'registry.json.cache');

  try {
    const info = await stat(file);

    if (Date.now() - info.mtimeMs < options.maxAgeHours * 3600000) {
      return JSON.parse(await readFile(file, 'utf8')) as RegistryMetadata;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  options.log(`Fetching ${PACKAGE_NAME} registry metadata`);
  const response = await fetch(`${REGISTRY}/${PACKAGE_NAME}`, { signal: options.signal, headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`Schema registry returned HTTP ${response.status}`);
  }

  const result = await response.json() as RegistryMetadata;

  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(result));

  return result;
}

/** Cache Mojang's schema data; exact cached versions need no registry access. */
export async function ensureSchemaPackage(options: SchemaPackageOptions): Promise<{ version: string; root: string }> {
  options.signal?.throwIfAborted();
  const requested = versionFolder(options.version);
  const exactRoot = path.join(options.cacheDir, requested);

  if (/^\d/.test(requested) && await exists(path.join(exactRoot, '.complete'))) {
    return { version: requested, root: exactRoot };
  }

  const registry = await metadata(options);
  const version = versionFolder(registry['dist-tags']?.[requested] ?? requested);
  const entry = registry.versions?.[version];

  if (!entry) {
    throw new Error(`Unknown ${PACKAGE_NAME} version: ${requested}`);
  }

  const root = path.join(options.cacheDir, version);

  if (await exists(path.join(root, '.complete'))) {
    return { version, root };
  }

  options.log(`Downloading ${PACKAGE_NAME}@${version}`);
  const response = await fetch(entry.dist.tarball, { signal: options.signal });

  if (!response.ok) {
    throw new Error(`Schema download returned HTTP ${response.status}`);
  }

  const files = extractTgz(Buffer.from(await response.arrayBuffer()));

  await mkdir(options.cacheDir, { recursive: true });
  const candidate = await mkdtemp(path.join(options.cacheDir, '.unpack-'));

  try {
    let written = 0;

    for (const [name, content] of files) {
      options.signal?.throwIfAborted();

      if (!name.startsWith('package/')) {
        continue;
      }

      const relative = name.slice('package/'.length);

      if (!KEEP.some(pattern => pattern.test(relative))) {
        continue;
      }

      if (relative.split('/').includes('..') || path.isAbsolute(relative) || relative.includes(':')) {
        throw new Error(`Invalid path in schema package: ${name}`);
      }

      const destination = path.join(candidate, relative);

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
      written++;
    }

    if (!written || !await exists(path.join(candidate, 'catalog.json'))) {
      throw new Error(`${PACKAGE_NAME}@${version} contains no schema catalog`);
    }

    await writeFile(path.join(candidate, '.complete'), version);
    // The version directory is inside the owned cache and can contain an incomplete unpack.
    await rm(root, { recursive: true, force: true });
    await rename(candidate, root);
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }

  return { version, root };
}
