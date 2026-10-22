import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext } from '@bedrock-core/builder-plugin';

export const requirements = { modules: ['data'] };

export async function run(context: BuildContext, settings: { consume?: boolean }) {
  const pack = context.pack;

  if (!pack) {
    throw new Error('The items plugin requires a current pack');
  }

  const id = `items:${pack.id}`;

  if (settings.consume) {
    const data = await readFile(context.artifact(id).path, 'utf8');

    await writeFile(path.join(pack.path, 'generated-items.json'), data);

    return;
  }

  context.registerDependency('items.json');
  const items = JSON.parse(await readFile(path.join(context.stagedRoot, 'items.json'), 'utf8'));
  const generated = path.join(context.generatedDir, `items-${pack.id}.json`);

  await writeFile(generated, JSON.stringify(items));
  await context.registerArtifact(id, generated);
}
