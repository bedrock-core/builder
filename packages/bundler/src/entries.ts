import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { scriptOutputEntry } from '@bedrock-core/builder-manifest';

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);

    if (!info.isFile()) {
      throw new Error(`Expected a regular file at ${file}`);
    }

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/** Return the exact authored source entry. */
export function scriptCandidates(entry: string): string[] {
  return [entry];
}

/** Resolve the authored source and reject an existing TypeScript output collision. */
export async function scriptSource(packId: string, entry: string, directory?: string): Promise<string> {
  const output = scriptOutputEntry(entry);
  const display = (file: string) => (directory === undefined ? file : path.relative(directory, file)).replaceAll('\\', '/');
  const description = `Pack ${packId} manifest entry ${display(entry)} (output ${display(output)})`;

  if (!await isFile(entry)) {
    throw new Error(`${description} does not exist. Set the manifest entry to the actual source file.`);
  }

  if (entry !== output && await isFile(output)) {
    throw new Error(`${description} collides with authored JavaScript alongside ${display(entry)}. Move or remove ${display(output)}, or choose a different entry name.`);
  }

  return entry;
}
