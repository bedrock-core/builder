import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SchemaNode } from './normalize.ts';

/** Register an owned document root alongside the upstream catalog. */
export async function writeCatalogSchema(source: string, key: string, schema: SchemaNode): Promise<void> {
  const url = './schemas/' + key + '/index.schema.json';
  const file = path.join(source, url);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(schema));
  const catalogFile = path.join(source, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8')) as { schemas: { url: string }[] };

  if (!catalog.schemas.some(entry => entry.url === url)) {
    catalog.schemas.push({ url });
    await writeFile(catalogFile, JSON.stringify(catalog));
  }
}
