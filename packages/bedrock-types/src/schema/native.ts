import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve references inside the package-owned copy of Mojang's native schemas. */
export async function prepareNativeSchemas(source: string, input: string): Promise<void> {
  const root = path.join(source, 'schemas/metadata');

  await cp(input, root, { recursive: true });

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.name.endsWith('.json')) {
        const document = JSON.parse(await readFile(file, 'utf8'));

        const rewrite = (value: unknown): void => {
          if (value === null || typeof value !== 'object') {
            return;
          }

          const node = value as Record<string, unknown>;

          delete node.$id;

          if (typeof node.$ref === 'string' && !node.$ref.startsWith('#') && !/^[a-z]+:/i.test(node.$ref)) {
            const [reference, fragment] = node.$ref.split('#');
            const target = reference.startsWith('/') ? path.join(root, decodeURIComponent(reference)) : path.resolve(path.dirname(file), decodeURIComponent(reference));

            node.$ref = pathToFileURL(target).href + (fragment ? '#' + fragment : '');
          }

          Object.values(node).forEach(rewrite);
        };

        rewrite(document);
        await writeFile(file, JSON.stringify(document));
      }
    }
  };

  await visit(root);
}
