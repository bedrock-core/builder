import { lstat } from 'node:fs/promises';

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/** Prefer typed sources corresponding to a manifest JavaScript entry. */
export function scriptCandidates(output: string): string[] {
  const stem = output.slice(0, -3);

  return ['.ts', '.tsx', '.mts', '.cts'].map(extension => `${stem}${extension}`).concat(output);
}

/** Resolve one unambiguous authored source; colliding outputs or missing entries fail. */
export async function scriptSource(packId: string, output: string): Promise<string> {
  const typedSources: string[] = [];

  for (const candidate of scriptCandidates(output).slice(0, -1)) {
    if (await exists(candidate)) {
      typedSources.push(candidate);
    }
  }

  if (typedSources.length > 1) {
    throw new Error(`Pack ${packId} has ambiguous sources for its manifest entry: ${output}`);
  }

  if (typedSources.length === 1) {
    if (await exists(output)) {
      throw new Error(`Bundler output already exists alongside its TypeScript source: ${output}`);
    }

    return typedSources[0]!;
  }

  if (await exists(output)) {
    return output;
  }

  throw new Error(`Pack ${packId} has no TS/JS source matching its manifest entry: ${output}`);
}
