import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { cacheDerivedValues } from '../src/values.ts';
import { callbackSourceId } from '../src/callbacks.ts';

const header = 'import { Text, useState } from "@bedrock-core/ui";\n';

async function evaluate(source, compatible = true) {
  const prepared = cacheDerivedValues(source, 'C:/addon/values.tsx');
  const result = await build({
    stdin: { contents: prepared, loader: 'tsx', resolveDir: 'C:/addon' },
    jsx: 'automatic', jsxImportSource: '@bedrock-core/ui', bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{ name: 'values', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'values' }));
      builder.onLoad({ filter: /.*/, namespace: 'values' }, args => ({
        contents: args.path.endsWith('/jsx-runtime')
          ? `export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;
            ${compatible ? 'export function __cacheValue(site, dependencies, compute) { globalThis.__valueCaptures.push({site, dependencies}); return compute(); }' : ''}`
          : 'export const Text = p => p; export const useState = value => [value, () => {}];',
        loader: 'js',
      }));
    } }],
  });

  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

test('infers initialized scalar inputs from props, state and earlier local constants', async () => {
  globalThis.__valueCaptures = [];

  try {
    const module = await evaluate(header + 'export function Page({prefix}) { const [count] = useState(2); const next = count + 1; const label = `${prefix}: ${next}/${count}`; return <Text>{label}</Text>; }');

    assert.equal(module.Page({ prefix: 'Rows' }).props.children, 'Rows: 3/2');
    assert.deepEqual(globalThis.__valueCaptures[0].dependencies, ['Rows', 3, 2]);
    const site = globalThis.__valueCaptures[0].site;

    assert.equal(module.Page({ prefix: 'Items' }).props.children, 'Items: 3/2');
    assert.equal(globalThis.__valueCaptures[1].site, site);
    assert.deepEqual(globalThis.__valueCaptures[1].dependencies, ['Items', 3, 2]);
  } finally { delete globalThis.__valueCaptures; }
});

test('keeps short-circuit evaluation and object coercion inside the lazy factory', async () => {
  const module = await evaluate(header + 'export function Page({active, value}) { useState(0); const label = active ? `Value: ${value}` : "Off"; return <Text>{label}</Text>; }', false);
  let reads = 0;
  const value = { toString() {
    reads++;

    return 'live';
  } };

  assert.equal(module.Page({ active: false, value }).props.children, 'Off');
  assert.equal(reads, 0);
  assert.equal(module.Page({ active: true, value }).props.children, 'Value: live');
  assert.equal(reads, 1);
});

for (const body of [
  'export function Page({value}) { useState(0); value++; const label = `${value}`; return <Text>{label}</Text>; }',
  'export function Page() { useState(0); let value = 1; const label = `${value}`; return <Text>{label}</Text>; }',
  'let value = 1; export function Page() { useState(0); const label = `${value}`; return <Text>{label}</Text>; }',
  'export function Page({record}) { useState(0); const label = `${record.label}`; return <Text>{label}</Text>; }',
  'export function Page({format}) { useState(0); const label = `${format()}`; return <Text>{label}</Text>; }',
  'export function Page() { useState(0); const label = `${later}`; const later = 1; return <Text>{label}</Text>; }',
  'export function Page() { useState(0); const label = `${label}`; return <Text>{label}</Text>; }',
  'export function Page({rows}) { useState(0); return <Text>{rows.map(value => { const label = `${value}`; return label; })}</Text>; }',
  'export function Page({value}) { useState(0); for (const row of rows) { const label = `${value}`; } return <Text />; }',
  'export function Page({value}) { useState(0); const label = value + 1; return <Text>{label}</Text>; }',
  'export function Page({value}) { const label = `${value}`; return <Text>{label}</Text>; }',
  'export function Page({value}) { useState(0); eval(code); const label = `${value}`; return <Text>{label}</Text>; }',
  'const Reflect = {}; export function Page({value}) { useState(0); const label = `${value}`; return <Text>{label}</Text>; }',
]) {
  test(`preserves unsupported or inexpensive expressions: ${body}`, () => {
    const source = header + body;

    assert.equal(cacheDerivedValues(source), source);
  });
}

test('recognizes actual hook aliases and namespaces while respecting shadowing', () => {
  for (const source of [
    'import {useState as state, Text} from "@bedrock-core/ui"; export function Page({value}) { state(0); const label = `${value}`; return <Text>{label}</Text>; }',
    'import * as UI from "@bedrock-core/ui-runtime"; export const Page = ({value}) => { UI.useContext(context); const label = `${value}`; return <UI.Text>{label}</UI.Text>; };',
  ]) { assert.match(cacheDerivedValues(source), /__cacheValue/); }

  const source = header + 'export function Page({value, useState}) { useState(0); const label = `${value}`; return <Text>{label}</Text>; }';

  assert.equal(cacheDerivedValues(source), source);
});

test('handles same-statement declarations, type wrappers and non-ASCII source positions', () => {
  const source = header + 'const __coreValue = "🙂 日本語"; export function Page({value}) { useState(0); const first = value, label = `${first as string}`; return <Text>{label}</Text>; }';
  const prepared = cacheDerivedValues(source);

  assert.match(prepared, /function __coreValue_\(/);
  assert.match(prepared, /const __coreValue = "🙂 日本語"/);
  assert.match(prepared, /\[first\], \(\) => \(`\$\{first as string\}`\)/);
  assert.equal(cacheDerivedValues(prepared), prepared);
});

test('supports older runtimes and calls before the generated helper declaration', async () => {
  const module = await evaluate(header + 'export function Page({value}) { useState(0); const label = `${value}`; return <Text>{label}</Text>; } export const initial = Page({value: "Ready"});', false);

  assert.equal(module.initial.props.children, 'Ready');
});

test('keeps sites stable across temporary workspaces', () => {
  const source = header + 'export function Page({value}) { useState(0); const label = `${value}`; return <Text>{label}</Text>; }';
  const first = 'C:/temporary/first/project/Page.tsx';
  const second = 'C:/temporary/second/project/Page.tsx';

  assert.equal(cacheDerivedValues(source, first, callbackSourceId(first, 'C:/temporary/first/project')),
    cacheDerivedValues(source, second, callbackSourceId(second, 'C:/temporary/second/project')));
});
