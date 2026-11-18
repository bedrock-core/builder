import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ESLint, Linter } from 'eslint';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
import { files } from '../src/files.ts';
import { extensionlessImports } from '../src/schema/imports.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the complete distribution uses extensionless named imports, useful comments and spaced interfaces', async () => {
  const eslint = new ESLint({ cwd: path.resolve(root, '../..') });
  const config = await eslint.calculateConfigForFile(path.join(root, 'types/registries.d.ts'));
  const rule = config.rules['@stylistic/padding-line-between-statements'];

  assert.ok(rule.some((entry: unknown) => JSON.stringify(entry).includes('TSInterfaceDeclaration')));
  const linter = new Linter();
  const lintConfig = {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@stylistic': stylistic },
    rules: { '@stylistic/padding-line-between-statements': rule },
  };
  const unspaced = linter.verify('export interface A { a: number; }\nexport interface B { b: number; }', lintConfig, 'output.d.ts');

  assert.ok(unspaced.some(message => message.ruleId === '@stylistic/padding-line-between-statements'));

  for (const name of Object.keys(await files(path.join(root, 'dist'))).filter(name => name.endsWith('.d.ts'))) {
    const text = await readFile(path.join(root, 'dist', name), 'utf8');

    assert.equal(extensionlessImports(text), text, 'Extensionless declaration specifiers in ' + name);

    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

    const checkImports = (node: ts.Node): void => {
      assert.equal(ts.isImportTypeNode(node), false, 'Use a top-level type import in ' + name);
      node.forEachChild(checkImports);
    };

    checkImports(source);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);

    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        assert.ok(scanner.getTokenText().slice(2, -2).replace(/[\s*]/g, '').length, 'Empty comment in ' + name);
      }
    }

    assert.deepEqual(linter.verify(text, lintConfig, 'output.d.ts'), [], 'Interface spacing in ' + name);
  }
});

test('block documents reuse one compact canonical collision-box declaration', async () => {
  const component = await readFile(path.join(root, 'dist/blocks/components.d.ts'), 'utf8');
  const document = await readFile(path.join(root, 'dist/blocks/document.d.ts'), 'utf8');

  assert.match(component, /BoundedArray<BoundingBoxData, 0, 16>/);
  assert.doesNotMatch(document, /export (type|interface) (CollisionBox|NativeBlockComponents)\b/);
  assert.match(document, /components\??: BlockComponents;/);
});
