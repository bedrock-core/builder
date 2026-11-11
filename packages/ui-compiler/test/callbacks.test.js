import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { callbackSourceId, cacheInlineCallbacks } from '../src/callbacks.ts';

const header = 'import { Button, Panel, useState } from \'@bedrock-core/ui\';\n';

async function evaluate(source, compatible = true) {
  const prepared = cacheInlineCallbacks(source, 'C:/addon/callbacks.tsx');
  const result = await build({
    stdin: { contents: prepared, loader: 'tsx', resolveDir: 'C:/addon' },
    jsx: 'automatic', jsxImportSource: '@bedrock-core/ui', bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{ name: 'callbacks', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'callbacks' }));
      builder.onLoad({ filter: /.*/, namespace: 'callbacks' }, args => ({
        contents: args.path.endsWith('/jsx-runtime')
          ? `export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;
            ${compatible ? 'export function __cacheCallback(site, dependencies, callback) { globalThis.__callbackCaptures.push({site, dependencies}); return callback; }' : ''}`
          : 'export const Button = p => p; export const Panel = p => p; export const useState = initial => [initial, globalThis.__callbackSetter];',
        loader: 'js',
      }));
    } }],
  });

  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

test('infers destructured props and state captures using native semantic symbols', async () => {
  globalThis.__callbackCaptures = [];

  globalThis.__callbackSetter = () => {};

  try {
    const module = await evaluate(header + 'export function Page({ step }) { const [count, setCount] = useState(2); return <Button onPress={() => setCount(count + step)} />; }');

    module.Page({ step: 3 });
    assert.deepEqual(globalThis.__callbackCaptures[0].dependencies, [globalThis.__callbackSetter, 2, 3]);
    const site = globalThis.__callbackCaptures[0].site;

    module.Page({ step: 4 });
    assert.equal(globalThis.__callbackCaptures[1].site, site);
    assert.equal(globalThis.__callbackCaptures[1].dependencies.at(-1), 4);
  } finally {
    delete globalThis.__callbackCaptures;
    delete globalThis.__callbackSetter;
  }
});

test('tracks shorthand captures, excludes event parameters and respects shadowing', async () => {
  globalThis.__callbackCaptures = [];

  try {
    const module = await evaluate(header + 'export function Page({ label, emit }) { const onPress = event => emit({ label, event, nested: label => label }); return <Button onPress={onPress} />; }');
    const emit = value => value;
    const tree = module.Page({ label: 'Current', emit });

    assert.deepEqual(globalThis.__callbackCaptures[0].dependencies, [emit, 'Current']);
    assert.deepEqual(tree.props.onPress('event').label, 'Current');
  } finally { delete globalThis.__callbackCaptures; }
});

test('reads object captures by reference and keeps event-time getters live', async () => {
  globalThis.__callbackCaptures = [];

  try {
    const module = await evaluate(header + 'export function Page({ record }) { return <Button onPress={() => record.label} />; }');
    let reads = 0;
    let label = 'first';
    const record = { get label() {
      reads++;

      return label;
    } };
    const tree = module.Page({ record });

    assert.deepEqual(globalThis.__callbackCaptures[0].dependencies, [record]);
    assert.equal(reads, 0);
    label = 'changed';
    assert.equal(tree.props.onPress(), 'changed');
  } finally { delete globalThis.__callbackCaptures; }
});

for (const body of [
  'export function Page({ value }) { value++; return <Button onPress={() => value} />; }',
  'export function Page() { let value = 1; return <Button onPress={() => value} />; }',
  'export function Page() { const cb = () => later; const later = 1; return <Button onPress={cb} />; }',
  'export function Page() { const cb = () => cb(); return <Button onPress={cb} />; }',
  'export function Page() { return <Button onPress={() => this.value} />; }',
  'export function Page() { return <Button onPress={() => arguments[0]} />; }',
  'export function Page({ rows }) { return <Panel>{rows.map(row => <Button onPress={() => row} />)}</Panel>; }',
  'export function Page() { for (const row of rows) { const cb = () => row; } return <Panel />; }',
  'export function Page() { eval(code); return <Button onPress={() => value} />; }',
]) {
  test(`preserves unsupported or mutable capture logic: ${body}`, () => {
    const source = header + body;

    assert.equal(cacheInlineCallbacks(source), source);
  });
}

test('module variables stay live and compiler support works before its textual declaration', async () => {
  const source = header + 'let value = 1; export function Page() { return <Button onPress={() => value} />; } export const initial = Page(); export function change() { value = 2; }';
  const module = await evaluate(source, false);

  module.change();
  assert.equal(module.initial.props.onPress(), 2);
});

test('is idempotent, avoids helper name collisions and preserves UTF-16 source positions', () => {
  const source = header + 'const __coreCallback = "🙂"; export function Page({ value }) { return <Button onPress={() => value} />; }';
  const prepared = cacheInlineCallbacks(source);

  assert.match(prepared, /function __coreCallback_\(/);
  assert.match(prepared, /const __coreCallback = "🙂"/);
  assert.equal(cacheInlineCallbacks(prepared), prepared);
});

test('does not add a Core runtime dependency for a type-only import', () => {
  const source = 'import type { JSX } from \'@bedrock-core/ui\'; export function Other() { return <External onPress={() => 1} />; }';

  assert.equal(cacheInlineCallbacks(source), source);
});

test('callback sites stay stable across temporary build workspaces', () => {
  const source = header + 'export function Page({ value }) { return <Button onPress={() => value} />; }';
  const first = 'C:/temporary/first/project/Page.tsx';
  const second = 'C:/temporary/second/project/Page.tsx';

  assert.equal(cacheInlineCallbacks(source, first, callbackSourceId(first, 'C:/temporary/first/project')),
    cacheInlineCallbacks(source, second, callbackSourceId(second, 'C:/temporary/second/project')));
});
