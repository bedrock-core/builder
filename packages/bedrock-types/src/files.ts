import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return false;
  }
}

export async function files(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error('Release files must not contain symbolic links');
    }

    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      for (const [name, digest] of Object.entries(await files(file))) {
        result[entry.name + '/' + name] = digest;
      }
    } else if (entry.isFile()) {
      result[entry.name] = hash(await readFile(file));
    }
  }

  return result;
}

export async function safe(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);

  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Generated paths must remain inside their package');
  }

  let current = root;

  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);

    if ((await exists(current)) && (await lstat(current)).isSymbolicLink()) {
      throw new Error('Generated paths must not use symlinks');
    }
  }
}
