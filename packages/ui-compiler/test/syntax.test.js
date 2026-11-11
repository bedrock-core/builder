import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSource, parseSource, ScriptKind, isVariableStatement } from '../src/syntax.ts';
import { markRuntimeText } from '../src/text.ts';

test('native semantic snapshots include JavaScript package entry points', () => {
  const source = 'import { Text } from \'@bedrock-core/ui\'; export const caption = value => Text({ children: value });';

  assert.match(markRuntimeText(source, 'C:/addon/node_modules/library/index.js'), /__textDynamic: true/);
});

test('native symbol handles resolve within their owning snapshot', () => {
  using source = analyzeSource('C:/addon/values.ts', 'export const answer = 42;');
  const statement = source.file.statements.find(isVariableStatement);
  const declaration = statement.declarationList.declarations[0];
  const value = source.checker.getSymbolAtLocation(declaration.name);

  assert.equal(value.valueDeclaration.resolve(), declaration);
});

test('source leases preserve JavaScript text and offsets', () => {
  using source = parseSource('client.js', 'const value = "Native";', ScriptKind.JS);
  assert.equal(source.file.statements[0].getText(source.file), 'const value = "Native";');
});

test('successive native snapshots observe replacement source without retaining old content', () => {
  for (const value of [1, 2, 3]) {
    using source = analyzeSource('C:/addon/replaced.ts', `export const value = ${value};`);
    assert.equal(source.file.text, `export const value = ${value};`);
  }
});

test('native source edits retain UTF-16 offsets after non-ASCII text', () => {
  const prefix = 'const heading = "🙂 España 日本語"; ';
  const body = 'import { Text } from \'@bedrock-core/ui\'; export const Row = props => <Text>{props.label}</Text>;';
  const rewritten = markRuntimeText(prefix + body, 'C:/addon/unicode.tsx');

  assert.equal(rewritten, prefix + markRuntimeText(body, 'C:/addon/unicode.tsx'));
});
