import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { markPureComponents } from '../src/pure.ts';
import { markRuntimeText } from '../src/text.ts';
import { desugarJsxConditionals } from '../src/sugar.ts';

const marker = Symbol.for('@bedrock-core/ui/compiler/pure');
const header = 'import { Text, Panel, Button, useState } from \'@bedrock-core/ui\';\n';

async function evaluate(source) {
  const prepared = markPureComponents(markRuntimeText(desugarJsxConditionals(source, '/addon/test.screen.tsx'), '/addon/test.screen.tsx'), '/addon/test.screen.tsx');
  const result = await build({
    stdin: { contents: prepared, loader: 'tsx', resolveDir: '/addon' },
    jsx: 'automatic', jsxImportSource: '@bedrock-core/ui',
    bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{
      name: 'pure-test',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'pure-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'pure-test' }, args => ({
          contents: args.path.endsWith('/jsx-runtime')
            ? 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = p => p;'
            : 'export const Text = p => p; export const Panel = p => p; export const Button = p => p; export const useState = () => [0];',
          loader: 'js',
        }));
      },
    }],
  });

  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

for (const body of [
  'export function Row({ label }) { return <Text>{label}</Text>; }',
  'export const Row = ({ label }) => <Text>{label}</Text>;',
  'export const Row = function Row(props) { return <Text>{props.label}</Text>; };',
  'const prefix = "Hello "; export function Row({ label }) { const caption = `${prefix}${label}`; return <Panel><Text>{caption}</Text></Panel>; }',
  'export function Row({ label, onPress }) { return <Button onPress={onPress}><Text>{label}</Text></Button>; }',
  'export function Row(props) { const caption = <Text>{props.label}</Text>; return <Panel>{caption}</Panel>; }',
  'export function Row({ visible, label }) { return <Panel>{visible && <Text>{label}</Text>}</Panel>; }',
]) {
  test(`automatically marks pure JSX: ${body}`, async () => {
    const module = await evaluate(header + body);

    assert.equal(module.Row[marker], true);
    assert.equal(typeof module.Row, 'function');
  });
}

test('preserves function identity and named/default exports', async () => {
  const module = await evaluate(header + 'export default function Row({ label }) { return <Text>{label}</Text>; } export { Row };');

  assert.equal(module.default, module.Row);
  assert.equal(module.Row.name, 'Row');
  assert.equal(module.Row[marker], true);
});

test('recognizes Core import aliases and namespaces', async () => {
  const module = await evaluate('import { Text as Caption } from \'@bedrock-core/ui-runtime\'; import * as UI from \'@bedrock-core/ui\'; export const Row = props => <UI.Panel><Caption>{props.label}</Caption></UI.Panel>;');

  assert.equal(module.Row[marker], true);
});

for (const body of [
  'export function Row({ onPress, label }) { return <Button onPress={onPress}><Text>{label}</Text></Button>; }',
  'export function Row({ onPress: handle }) { return <Button onPress={handle} />; }',
  'export function Row(props) { return <Button onPress={props.onPress} />; }',
  'export function Row(props) { return <Button onPress={props["onPress"]} />; }',
]) {
  test(`records callback props used only as forwarded handlers: ${body}`, async () => {
    const module = await evaluate(header + body);
    const forwarded = module.Row[Symbol.for('@bedrock-core/ui/compiler/callback-props')];

    assert.deepEqual(forwarded, ['onPress']);
    assert.equal(Object.isFrozen(forwarded), true);
  });
}

for (const body of [
  'export function Row({ onPress }) { return <Button onPress={onPress}><Text>{`${onPress}`}</Text></Button>; }',
  'export function Row(props) { return <Panel><Button onPress={props.onPress} /><Text>{props.onPress}</Text></Panel>; }',
  'export function Row(props) { return <Panel><Button onPress={props.onPress} /><Text>{props}</Text></Panel>; }',
  'export function Row({ onPress }) { const alias = onPress; return <Button onPress={alias} />; }',
]) {
  test(`retains live function props used outside handler forwarding: ${body}`, async () => {
    const module = await evaluate(header + body);

    assert.equal(module.Row[Symbol.for('@bedrock-core/ui/compiler/callback-props')], undefined);
  });
}

test('handles multiple component declarations and is idempotent', () => {
  const source = header + 'export const One = () => <Text>One</Text>, Two = () => <Text>Two</Text>;';
  const result = markPureComponents(source);

  assert.equal((result.match(/Object.defineProperty/g) ?? []).length, 2);
  assert.equal(markPureComponents(result), result);
});

test('normalizes Windows source paths before symbol analysis', () => {
  const source = header + 'export function Row({ label }) { return <Text>{label}</Text>; }';

  assert.match(markPureComponents(source, 'C:\\addon\\Row.tsx'), /Object.defineProperty\(Row,/);
});

for (const body of [
  'export function Row() { const [value] = useState(0); return <Text>{value}</Text>; }',
  'export function Row() { return <Text>{Date.now()}</Text>; }',
  'export function Row() { return <Text>{Math.random()}</Text>; }',
  'let value = "live"; export function Row() { return <Text>{value}</Text>; }',
  'const data = { label: "live" }; export function Row() { return <Text>{data.label}</Text>; }',
  'let value = "live"; const alias = value; export function Row() { return <Text>{alias}</Text>; }',
  'export function Row(props) { return <Text>{props.label.toUpperCase()}</Text>; }',
  'export function Row(props) { return <Text>{props.record.label}</Text>; }',
  'export function Row({ callback }) { return <Text>{callback.label}</Text>; }',
  'export function Row(props) { console.log(props); return <Text>{props.label}</Text>; }',
  'export function Row(props) { props.label = "changed"; return <Text>{props.label}</Text>; }',
  'export function Row(props) { let caption = props.label; return <Text>{caption}</Text>; }',
  'export function Row(props) { return <Button onPress={() => console.log(props.label)} />; }',
  'export async function Row(props) { return <Text>{props.label}</Text>; }',
  'export function* Row(props) { return <Text>{props.label}</Text>; }',
  'export function Row(props) { return <Text {...props} />; }',
  'export function Row({ [Date.now()]: label }) { return <Text>{label}</Text>; }',
  'export function Row(props = makeProps()) { return <Text>{props.label}</Text>; }',
  'export function Row(props) { return <label>{props.label}</label>; }',
  'export function Row(props) { return <Text>{globalThis.liveValue}</Text>; }',
  'const Object = {}; export function Row(props) { return <Text>{props.label}</Text>; }',
  'const Symbol = {}; export function Row(props) { return <Text>{props.label}</Text>; }',
]) {
  test(`leaves unproven render logic unoptimized: ${body}`, () => {
    const source = header + body;

    assert.equal(markPureComponents(source), source);
  });
}

test('does not cache mutable component bindings or parents capturing them', () => {
  for (const assignment of ['Row = Other;', '({ Row } = object);']) {
    const source = header + `export function Row() { return <Text>One</Text>; } export function Parent() { return <Row />; } ${assignment}`;

    assert.equal(markPureComponents(source), source);
  }
});

test('does not assume imported data or custom imports are immutable components', () => {
  const source = header + 'import { data, Custom } from "./other"; export const Row = () => <Text>{data}</Text>; export const Parent = () => <Custom />;';

  assert.equal(markPureComponents(source), source);
});

test('leaves dynamic scope and property-mutated component groups unoptimized', () => {
  for (const suffix of ['eval(code);', 'for (Row of replacements) {}', 'for (Row in replacements) {}']) {
    const source = header + `export function Row() { return <Text>One</Text>; } ${suffix}`;

    assert.equal(markPureComponents(source), source);
  }

  const source = header + 'export function Group() { return <Text>One</Text>; } export function Row() { return <Group.Row />; }';

  assert.doesNotMatch(markPureComponents(source), /Object.defineProperty\(Row,/);
});
