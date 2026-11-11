import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const containers = new Set(['behavior_packs', 'resource_packs']);
// Creator Tools 0.20.0 strips these pack folder names from its path budget.
const packAliases = new Set(['bp', 'rp', 'behavior pack', 'resource pack', 'behavior_pack', 'resource_pack', 'skin_pack', 'world', 'world_template']);
const assetFiles = new Map([
  ['textures', /\.(png|tga|jpe?g)$/i],
  ['sounds', /\.(ogg|wav|fsb)$/i],
  ['functions', /\.mcfunction$/i],
  ['loot_tables', /\.json$/i],
  ['trading', /\.json$/i],
]);
const maxDepth = 8;

interface PathAuditOptions {
  maxLength: number;
  folders?: { creator: string; pack: string };
}

interface PackRoot {
  directory: string;
  relative: string;
  prefix: string;
}

interface PathFinding {
  rule: 'path-length' | 'path-depth' | 'asset-folder';
  path: string;
  message: string;
}

async function hasManifest(directory: string): Promise<boolean> {
  try {
    return (await lstat(path.join(directory, 'manifest.json'))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function packRoots(root: string): Promise<PackRoot[]> {
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`Path audit requires a pack or unpacked add-on directory: ${root}`);
  }

  if (await hasManifest(root)) {
    return [{ directory: root, relative: '.', prefix: '' }];
  }

  const packs: PackRoot[] = [];

  for (const container of await readdir(root, { withFileTypes: true })) {
    if (!containers.has(container.name.toLowerCase())) {
      continue;
    }

    const directory = path.join(root, container.name);

    if (!container.isDirectory()) {
      throw new Error(`Path audit requires a real pack container directory: ${directory}`);
    }

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pack = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`Path audit cannot follow a link: ${pack}`);
      }

      if (entry.isDirectory() && await hasManifest(pack)) {
        packs.push({
          directory: pack,
          relative: path.posix.join(container.name, entry.name),
          prefix: packAliases.has(entry.name.toLowerCase()) ? '' : entry.name,
        });
      }
    }
  }

  if (!packs.length) {
    throw new Error(`No pack manifests found at ${root} or under its behavior_packs and resource_packs directories`);
  }

  return packs.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function packFiles(directory: string, files: string[] = [], prefix = ''): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const file = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Path audit cannot follow a link: ${file}`);
    }

    if (entry.isDirectory()) {
      await packFiles(file, files, relative);
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files;
}

/** Audit the file names of an existing pack or unpacked add-on. */
export async function auditPackPaths(directory: string, { maxLength, folders }: PathAuditOptions) {
  const packs = [];

  for (const pack of await packRoots(path.resolve(directory))) {
    const files = (await packFiles(pack.directory)).sort();
    const findings: PathFinding[] = [];
    let longest = { path: '', length: 0 };

    for (const file of files) {
      const measured = path.posix.join(pack.prefix, file);
      const length = measured.length;
      const depth = measured.split('/').length - 1;
      const segments = file.split('/');
      const category = segments[0];

      if (length > longest.length) {
        longest = { path: measured, length };
      }

      if (length > maxLength) {
        findings.push({ rule: 'path-length', path: measured, message: `Path length ${length} exceeds the ${maxLength}-character budget` });
      }

      if (depth > maxDepth) {
        findings.push({ rule: 'path-depth', path: measured, message: `Directory depth ${depth} exceeds the ${maxDepth}-level budget` });
      }

      if (!assetFiles.get(category)?.test(file)) {
        continue;
      }

      const [, creator, name] = segments;

      if (segments.length < 4 || (folders && (creator !== folders.creator || (name !== folders.pack && name !== 'common')))) {
        const expected = folders ? `${folders.creator}/${folders.pack}/` : '<creator>/<pack>/';

        findings.push({ rule: 'asset-folder', path: measured, message: `Cooperative add-ons should place these assets under ${category}/${expected}` });
      }
    }

    packs.push({ path: pack.relative, files: files.length, longest, findings });
  }

  return { limits: { length: maxLength, depth: maxDepth }, packs };
}
