import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext } from '../contract.d.ts';
import { transformManifest, type ManifestOverrides } from '../manifest.ts';

export interface ManifestSettings {
  packs?: Record<string, ManifestOverrides>;
}

export async function run(context: BuildContext, settings: ManifestSettings): Promise<void> {
  for (const id of Object.keys(settings.packs ?? {})) {
    if (!Object.hasOwn(context.packs, id)) {
      throw new Error(`Manifest override refers to an unconfigured pack: ${id}`);
    }
  }

  for (const [id, directory] of Object.entries(context.packs)) {
    const file = path.join(directory, 'manifest.json');
    const input: unknown = JSON.parse(await readFile(file, 'utf8'));
    const output = transformManifest(input, settings.packs?.[id] ?? {});

    await writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
    context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, file)));
    await context.registerArtifact(`manifest:${id}`, file);
  }
}
