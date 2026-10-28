import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { markRuntimeText } from '../src/text.ts';

async function evaluate(source) {
  const prepared = markRuntimeText(source, '/addon/screen.tsx');
  const result = await build({
    stdin: { contents: prepared, loader: 'tsx', resolveDir: '/addon' },
    jsx: 'automatic', jsxImportSource: '@bedrock-core/ui',
    bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{
      name: 'text-runtime',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'text-runtime' }));
        builder.onLoad({ filter: /.*/, namespace: 'text-runtime' }, args => ({
          contents: args.path.endsWith('/jsx-runtime')
            ? 'export const jsx = (type, props) => type(props); export const jsxs = jsx;'
            : 'export const Text = props => props;',
          loader: 'js',
        }));
      },
    }],
  });

  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

test('runtime record captions remain dynamic when the build value is empty', async () => {
  const module = await evaluate('import { Text } from \'@bedrock-core/ui\'; export default (props = {}) => <Text>{props.record?.owner ?? \'\'}</Text>;');
  const initial = module.default();
  const populated = module.default({ record: { owner: 'Alex' } });

  assert.equal(initial.children, '');
  assert.equal(initial.__textDynamic, true);
  assert.equal(populated.children, 'Alex');
  assert.equal(populated.__textDynamic, true);
});

test('literal text and immutable primitive aliases stay baked', async () => {
  const module = await evaluate('import { Text } from \'@bedrock-core/ui\'; const caption = \'Constant\'; export default () => <Text>{caption}</Text>;');

  assert.equal(module.default().children, 'Constant');
  assert.equal(module.default().__textDynamic, undefined);
});

test('namespaced and aliased Core text factories carry runtime values', async () => {
  const namespace = await evaluate('import * as UI from \'@bedrock-core/ui\'; export default props => UI.Text({ children: props.value });');
  const alias = await evaluate('import { Text as Caption } from \'@bedrock-core/ui\'; export default props => <Caption>{props.value}</Caption>;');

  assert.equal(namespace.default({ value: 'one' }).__textDynamic, true);
  assert.equal(alias.default({ value: 'two' }).__textDynamic, true);
});

test('text helper props are classified without an author declaration', async () => {
  const module = await evaluate('import { Text } from \'@bedrock-core/ui-runtime\'; const line = source => <Text>{source}</Text>; export default props => line(props.title);');

  assert.equal(module.default({ title: '327 items' }).children, '327 items');
  assert.equal(module.default({ title: '327 items' }).__textDynamic, true);
});

test('shadowed and unrelated Text components retain their original props', async () => {
  const shadow = await evaluate('import { Text } from \'@bedrock-core/ui\'; export default Text => Text({ children: \'own\' });');
  const unrelated = await evaluate('import { Text } from \'other-ui\'; export default props => <Text>{props.value}</Text>;');

  assert.equal(shadow.default(props => props).__textDynamic, undefined);
  assert.equal(unrelated.default({ value: 'other' }).__textDynamic, undefined);
});

test('classification is idempotent and does not repeat caption evaluation', async () => {
  const source = 'import { Text } from \'@bedrock-core/ui\'; let calls = 0; export default () => Text({children: String(++calls),});';
  const once = markRuntimeText(source, '/addon/screen.tsx');

  assert.equal(markRuntimeText(once, '/addon/screen.tsx'), once);
  const module = await evaluate(source);

  assert.equal(module.default().children, '1');
  assert.equal(module.default().children, '2');
});
