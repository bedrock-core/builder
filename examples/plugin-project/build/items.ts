import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext } from '../../../src/run.ts';

export async function run(context: BuildContext, settings: { consume?: boolean }) {
  if (settings.consume) {
    const data = await readFile(context.artifact('items').path, 'utf8');

    await writeFile(path.join(context.packs.behaviorPack, 'generated-items.json'), data);

    return;
  }

  context.registerDependency('items.json');
  const items = JSON.parse(await readFile(path.join(context.stagedRoot, 'items.json'), 'utf8'));
  const generated = path.join(context.generatedDir, 'items.json');

  await writeFile(generated, JSON.stringify(items));
  await context.registerArtifact('items', generated);
}
