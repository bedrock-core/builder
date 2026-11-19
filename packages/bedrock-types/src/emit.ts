import { cp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Category } from './schema/compile.ts';
import { exists } from './files.ts';
import { documentAliases } from './layout.ts';

/** Publish explicit domain barrels, typed document categories and shared document types. */
export async function emitEntryPoints(output: string, categories: readonly Category[], authored: string): Promise<void> {
  if (await exists(authored)) {
    await cp(authored, output, { recursive: true });
  }

  const groups = new Map<string, Category[]>();

  for (const category of categories) {
    const group = category.file.split('/')[0];

    groups.set(group, [...(groups.get(group) ?? []), category]);
  }

  for (const [group, entries] of groups) {
    const parts = (await readdir(path.join(authored, group)).catch(() => []))
      .filter(file => file.endsWith('.d.ts') && file !== 'index.d.ts')
      .sort();
    const lines = entries.flatMap((entry) => {
      const part = entry.file.slice(group.length + 1);

      return parts.includes(part + '.d.ts') ? [] : [`export type { ${entry.names?.join(', ') ?? entry.name} } from './${part}';`];
    });

    lines.push(...parts.map(file => `export type * from './${file.replace(/\.d\.ts$/, '')}';`));
    await writeFile(path.join(output, group, 'index.d.ts'), lines.join('\n') + '\n');
  }

  if (await exists(path.join(output, 'common/index.d.ts'))) {
    groups.set('common', []);
  }

  const lines = [...groups.keys()].sort().map(group => `export type * from './${group}/index';`);

  lines.push('export type { DocumentTypes, DocumentCategory } from \'./documents\';');

  if (await exists(path.join(output, 'registries.d.ts'))) {
    lines.push('export type * from \'./registries\';');
  }

  await writeFile(path.join(output, 'index.d.ts'), lines.join('\n') + '\n');
  const documentCategories = categories.filter(entry => !entry.key.startsWith('assets/'));

  await writeFile(
    path.join(output, 'documents.d.ts'),
    [
      ...documentCategories.map(entry => `import type { ${entry.name} } from './${entry.file}';`),
      '',
      '/** Native schema categories and their complete document types. */',
      'export interface DocumentTypes {',
      ...documentCategories.flatMap(entry =>
        [entry.key, ...Object.entries(documentAliases).filter(([, key]) => key === entry.key).map(([alias]) => alias)]
          .map(key => `  '${key}': ${entry.name};`)),
      '}',
      'export type DocumentCategory = keyof DocumentTypes;',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
}
