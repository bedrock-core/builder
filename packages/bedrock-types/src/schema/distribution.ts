import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript-native/ast';
import { API } from 'typescript-native/sync';
import { files } from '../files.ts';
import type { Category } from './compile.ts';
import { compactBoundedArrays } from './arrays.ts';
import { simplifyDeclarations } from './declarations.ts';
import { formatDeclarations } from './format.ts';
import { extensionlessImports } from './imports.ts';

/** Apply one cleanup policy to generated, vendored and authored declaration output. */
export async function prepareDistribution(output: string, categories: readonly Category[]): Promise<void> {
  using api = new API();
  const roots = new Map(categories.map(category => [category.file + '.d.ts', category.names ?? [category.name]]));

  for (const name of Object.keys(await files(output)).filter(name => name.endsWith('.d.ts'))) {
    const file = path.join(output, name);
    const original = await readFile(file, 'utf8');
    let stable = roots.get(name);

    if (!stable) {
      using parsed = api.createSourceFile(file, original);

      stable = parsed.sourceFile.statements.flatMap(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? [node.name.text] : []);
    }

    const relative = path.relative(path.dirname(file), path.join(output, 'common/primitives')).replaceAll('\\', '/');
    const compact = compactBoundedArrays(api, extensionlessImports(original), relative.startsWith('.') ? relative : './' + relative);
    const simplified = simplifyDeclarations(api, compact, stable);

    await writeFile(file, await formatDeclarations(simplified));
  }
}
