import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { uiRegistration } from '../src/output.ts';

async function evaluate(screens, entries = []) {
  const registration = uiRegistration({ screens }, entries, '/addon', 'example');
  const bundled = await build({
    stdin: {
      contents: `${registration}\nexport { registrations } from '@bedrock-core/ui';`,
      loader: 'ts',
      resolveDir: '/addon',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
      name: 'registration-runtime',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'registration-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'registration-test' }, args => ({
          contents: args.path === '@bedrock-core/ui'
            ? `
              export const registrations = { metadata: [], compiled: [], looks: [], static: [] };
              export const registerScreenMetadata = (...args) => registrations.metadata.push(args);
              export const registerCompiledScreen = (...args) => registrations.compiled.push(args);
              export const registerContainerLooks = (...args) => registrations.looks.push(args);
              export const registerStaticScreens = screens => registrations.static.push(...screens);
            `
            : 'export default function Screen() {}',
          loader: 'js',
        }));
      },
    }],
  });

  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
}

test('static registration preserves generic actions without importing navigation or screen components', async () => {
  const screen = {
    name: 'home',
    kind: 'action',
    title: 'home-title',
    table: { values: ['Inspect', 'Close'], actions: [{ kind: 'inspect', item: 3 }, null] },
  };
  const module = await evaluate([screen]);

  assert.deepEqual(module.registrations.static, [{
    key: 'example:home', title: 'home-title', values: ['Inspect', 'Close'], actions: [{ kind: 'inspect', item: 3 }, null],
  }]);
  assert.deepEqual(module.registrations.metadata, [[{ key: 'example:home', kind: 'action', parameters: {} }]]);
  assert.deepEqual(module.registrations.compiled, []);
  assert.deepEqual(module.SCREEN_KEYS, ['example:home']);
  assert.equal('uiReference' in module, false);
});

test('container metadata and looks share the same owning component', async () => {
  const screen = {
    name: 'inventory', host: { kind: 'entity', type: 'example:inventory' }, looks: ['first', 'second'],
    parameters: { category: { type: 'string' } },
  };
  const module = await evaluate([screen], [{ name: 'inventory', source: './inventory.screen.tsx' }]);
  const [[metadata, component]] = module.registrations.metadata;

  assert.deepEqual(metadata, { key: 'example:inventory', kind: 'entity', parameters: { category: { type: 'string' } } });
  assert.equal(typeof component, 'function');
  assert.equal(module.registrations.looks[0][0], component);
  assert.deepEqual(module.registrations.looks[0][1], ['first', 'second']);
  assert.deepEqual(module.registrations.compiled, []);
});

test('live forms retain their component, compiled identity and parameter contract', async () => {
  const screen = {
    name: 'edit', kind: 'modal', title: 'edit-title', snapshot: { shape: 'shape', baked: [], vis: [] },
    parameters: { item: { type: 'number' } },
  };
  const module = await evaluate([screen], [{ name: 'edit', source: './edit.screen.tsx' }]);
  const [[component, compiled]] = module.registrations.compiled;

  assert.equal(typeof component, 'function');
  assert.deepEqual(compiled, {
    key: 'example:edit', kind: 'modal', title: 'edit-title', snapshot: screen.snapshot, parameters: screen.parameters,
  });
  assert.deepEqual(module.registrations.metadata, [[{ key: 'example:edit', kind: 'modal', parameters: screen.parameters }]]);
  assert.deepEqual(module.registrations.static, []);
});
