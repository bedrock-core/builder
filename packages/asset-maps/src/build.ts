import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generationOptions, refreshAssets, type RefreshOptions, type RefreshReport } from './pipeline.ts';

/** Build the pinned, JSON-only Asset Maps distribution. */
export async function buildAssetMaps(options: RefreshOptions = {}): Promise<RefreshReport> {
  return refreshAssets(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.info(JSON.stringify(await buildAssetMaps(generationOptions(process.argv.slice(2))), null, 2));
}
