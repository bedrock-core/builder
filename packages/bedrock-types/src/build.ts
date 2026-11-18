import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateTypes, type GenerateResult } from './generate.ts';
import { withSchemaSdk } from './inputs/sdk.ts';
import { metadataSource, readReleases, reportsRoot, root } from './releases.ts';

/** Prepare the workspace distribution, or build a pinned release in isolation. */
export async function buildBedrockTypes(version?: string): Promise<GenerateResult> {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
  const selected = version ?? pkg.version;
  const releases = await readReleases();
  const release = Object.hasOwn(releases, selected) ? releases[selected] : undefined;

  if (!release) {
    throw new Error('Unknown Bedrock types release ' + selected + '. Available versions: ' + Object.keys(releases).join(', '));
  }

  const result = await withSchemaSdk(release, schemaRoot => generateTypes({
    root,
    schemaRoot,
    outputPath: version ? path.join(reportsRoot, version, 'dist') : undefined,
    metadata: metadataSource(release),
    archiveFile: process.env.BC_NATIVE_SCHEMA_ARCHIVE,
    log: console.info,
  }));

  console.info(`@bedrock-core/bedrock-types@${selected}: ${result.changed ? 'built' : 'cached'} ${result.categories.length} schema categories`);

  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildBedrockTypes(process.argv[2]);
}
