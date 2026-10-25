import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { stages } from '../plan.ts';
import type { FilterKind } from './types.ts';

/** Recognize canonical wrapper files in an explicitly trusted checkout without executing them. */
export async function localFilterKind(script: string, directory: string): Promise<FilterKind | undefined> {
  const canonical = await realpath(script);

  for (const stage of ['core', ...stages] as FilterKind[]) {
    try {
      const expected = await realpath(path.join(directory, stage, 'main.ts'));

      if (path.relative(expected, canonical) === '') {
        return stage;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
