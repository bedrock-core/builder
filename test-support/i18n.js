import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectFor } from './project.js';

export const english = {
  meta: { name: 'Shop', description: 'Sells items' },
  shop: {
    title: 'Shop',
    bought: 'Bought {{item}} for {{price}}; {{item}}.',
    intro: 'Welcome to $t(shop.title).',
    stock_one: '{{count}} item',
    stock_other: '{{count}} items',
  },
};

export const czech = {
  meta: { name: 'Obchod', description: 'Prodává předměty' },
  shop: {
    title: 'Obchod',
    bought: 'Za {{price}} koupen {{item}}; {{item}}.',
    intro: 'Vítejte: $t(shop.title).',
    stock_one: '{{count}} kus',
    stock_other: '{{count}} kusů',
    stock_few: '{{count}} kusy',
  },
};

export async function put(root, relative, content) {
  const file = path.join(root, relative);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);

  return file;
}

export async function translationsFor(t, options) {
  const project = await projectFor(t, options);

  await put(project.project, 'packs/gameplay/i18n/en_US.ts', `export default ${JSON.stringify(english)} as const;`);
  await put(project.project, 'packs/gameplay/i18n/cs_CZ.ts', `export default ${JSON.stringify(czech)} as const;`);

  return project;
}

export function compileOptions(project) {
  return {
    root: project.project,
    sourceDir: './packs/gameplay/i18n',
    namespace: 'flow_test',
    packs: [
      { path: './packs/gameplay', kind: 'behavior' },
      { path: './packs/visuals', kind: 'resource' },
    ],
  };
}
