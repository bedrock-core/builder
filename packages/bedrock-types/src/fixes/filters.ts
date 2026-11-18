import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { exists } from '../files.ts';
import { object } from '../schema/normalize.ts';

const filterFields = new Set([
  'filters', 'filter', 'interact_filters', 'broadcast_filters', 'nuisance_filter', 'entity_filter',
  'leader_filters', 'damage_filters', 'knockback_filters', 'target_block_filters', 'can_nap_filters',
  'love_filters', 'event_filters', 'projectile_filter', 'spawn_filter',
]);

function replaceFilterGroups(schema: unknown): boolean {
  let changed = false;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);

      return;
    }

    const node = object(value);
    const properties = object(node?.properties);

    if (properties) {
      for (const [name, value] of Object.entries(properties)) {
        const field = object(value);

        if (filterFields.has(name) && field && (field.type === 'object' || Array.isArray(field.anyOf))) {
          properties[name] = { description: field.description, tsType: 'FilterGroup' };
          changed = true;
        }
      }
    }

    if (node) {
      Object.values(node).forEach(visit);
    }
  }

  visit(schema);

  return changed;
}

/** Share the filter contract across entity components and nested triggers. */
export async function normalizeEntityFilters(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.schema.json')) {
      continue;
    }

    const file = path.join(directory, name);
    const schema: unknown = JSON.parse(await readFile(file, 'utf8'));

    if (replaceFilterGroups(schema)) {
      await writeFile(file, JSON.stringify(schema));
    }
  }
}

/** Emit test names and comparison value types from the selected Mojang SDK. */
export async function emitFilterValues(source: string, output: string): Promise<void> {
  const directory = path.join(source, 'types/bp/entities/filters');
  const target = path.join(output, 'common/filter-values.d.ts');
  const defaultValue = 'string | number | boolean';

  if (!(await exists(directory))) {
    if (await exists(path.dirname(target))) {
      await writeFile(target, `export type FilterValues = Record<string, ${defaultValue}>;\n`);
    }

    return;
  }

  const values = new Map<string, string>();

  for (const file of (await readdir(directory)).sort()) {
    if (!file.endsWith('.d.ts') || file === 'index.d.ts') {
      continue;
    }

    const contents = await readFile(path.join(directory, file), 'utf8');
    const name = /Entity Filters Documentation\s+-\s+minecraft:([a-z0-9_]+)/.exec(contents)?.[1];
    const declaration = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest);
    const filter = declaration.statements.find(ts.isInterfaceDeclaration);

    if (!name || !filter || values.has(name)) {
      throw new Error('Invalid entity filter declaration in the Mojang SDK: ' + file);
    }

    const value = filter.members.find(member => ts.isPropertySignature(member) && member.name.getText(declaration) === 'value');
    const type = value && ts.isPropertySignature(value) ? value.type?.getText(declaration) : undefined;

    if (type !== undefined && !['string', 'number', 'boolean'].includes(type)) {
      throw new Error('Unhandled entity filter value in ' + file + ': ' + type);
    }

    values.set(name, type ?? defaultValue);
  }

  const fields = [...values.entries()].sort(([left], [right]) => left.localeCompare(right));

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, [
    'export interface FilterValues {',
    ...fields.map(([name, type]) => `  ${name}: ${type};`),
    '}',
    '',
  ].join('\n'));
}
