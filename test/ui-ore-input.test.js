import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import test from 'node:test';
import { patchOreInputBundle } from '../packages/ui-compiler/src/ore-input.ts';

const component = 'function Field(props){const{onChange:changed}=props;const ref={current:props.input};ui("BaseTextField");React.useEffect(()=>{},[]);const keyboard=()=>changed(ref.current.value);return element("fast-input",keyboard);}';

test('links the existing native callback and ref without replacing the component behavior', () => {
  const source = patchOreInputBundle(component), effects = [], calls = [], bound = [];

  const input = { value: 'packet' }, changed = value => calls.push(value), dispose = () => {};

  const context = { React: { useEffect: effect => effects.push(effect) }, ui: () => {}, element: (tag, keyboard) => ({ tag, keyboard }), window: { __coreOreBindNativeInput: (node, callback) => {
    bound.push({ node, callback });

    return dispose;
  } } };
  const field = new Script(source + ';Field').runInNewContext(context);
  const result = field({ input, onChange: changed });

  assert.equal(result.tag, 'fast-input');
  assert.deepEqual(calls, []);
  assert.equal(effects.at(-1)(), dispose);
  assert.deepEqual(bound, [{ node: input, callback: changed }]);
  bound[0].callback('edit');
  assert.deepEqual(calls, ['edit']);
  result.keyboard();
  assert.deepEqual(calls, ['edit', 'packet']);
});

test('native components remain usable when the adapter is absent', () => {
  const effects = [];
  const field = new Script(patchOreInputBundle(component) + ';Field').runInNewContext({ React: { useEffect: effect => effects.push(effect) }, ui: () => {}, element: tag => tag, window: {} });

  assert.equal(field({ input: { value: '' }, onChange: () => {} }), 'fast-input');
  assert.doesNotThrow(() => effects.forEach(effect => effect()));
});

test('requires an unambiguous callback, ref and component marker', () => {
  for (const source of [component.replace('BaseTextField', 'OtherField'), component.replace('ref.current.value', '"value"'), component + '\n' + component.replace('function Field', 'function OtherField')]) {
    assert.throws(() => patchOreInputBundle(source), /Unsupported Ore text-field bundle/);
  }

  assert.throws(() => patchOreInputBundle(patchOreInputBundle(component)), /unmodified native Ore bundle/);
});
