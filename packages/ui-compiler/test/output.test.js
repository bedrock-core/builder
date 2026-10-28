import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uiRegistration, writeUiResource } from '../src/output.ts';

test('mixed Ore and JSON UI packs retain only concrete JSON UI screens in test metadata', async () => {
  const pack = await mkdtemp(path.join(os.tmpdir(), 'core-mixed-ui-'));

  try {
    const native = { name: 'native', document: { namespace: 'native' }, faces: {}, testMetadata: { screen: 'example:native', host: 'form-action', controls: [] } };
    const ore = { name: 'ore', ore: { schema: 'core-ore-layout/1' } };
    const linked = { screens: [native, ore], hooks: [], documents: [], lang: [], resources: [{ file: 'hbui/core-ore/example_ore.json', text: '{}' }] };
    const entries = [{ name: 'native', source: 'native.screen.tsx' }, { name: 'ore', source: 'ore.screen.tsx' }];
    const files = await writeUiResource(pack, linked, entries, 'example', { testMetadata: true });
    const metadata = JSON.parse(await readFile(path.join(pack, 'bedrock-core/test-metadata.json'), 'utf8'));

    assert.deepEqual(metadata.screens.map(screen => screen.metadata.screen), ['example:native']);
    assert(files.includes(path.join(pack, 'hbui/core-ore/example_ore.json')));
    linked.screens = [ore];
    const oreFiles = await writeUiResource(pack, linked, entries, 'example', { testMetadata: true });

    await assert.rejects(access(path.join(pack, 'bedrock-core/test-metadata.json')), { code: 'ENOENT' });
    assert(!oreFiles.includes(path.join(pack, 'bedrock-core/test-metadata.json')));
  } finally {
    assert.equal(path.dirname(pack), path.resolve(os.tmpdir()));
    await rm(pack, { recursive: true, force: true });
  }
});

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

test('shares identical immutable Ore nodes without changing screen identities or baseline data', async () => {
  const node = { id: 'n_0', kind: 'text', rect: [0, 0, 100, 20], initial: { id: 'n_0', text: 'literal " CORE_ORE_NODES[0]', visible: true, enabled: true } };
  const screens = ['first', 'second'].map(name => ({ name, title: name, kind: 'custom', snapshot: {
    ore: { schema: 'core-ore-layout/1', screen: name, nodes: [structuredClone(node)] }, shape: 'one', baked: [], vis: [],
  } }));
  const entries = screens.map(screen => ({ name: screen.name, source: screen.name + '.screen.tsx' }));
  const source = uiRegistration({ screens }, entries, '/addon', 'example');

  assert.equal(source.split(JSON.stringify(node)).length - 1, 1);
  const { registrations } = await evaluate(screens, entries);

  assert.deepEqual(registrations.compiled.map(([, descriptor]) => descriptor.key), ['example:first', 'example:second']);
  const first = registrations.compiled[0][1].snapshot.ore, second = registrations.compiled[1][1].snapshot.ore;

  assert.equal(first.nodes[0], second.nodes[0]);
  assert.deepEqual(first.nodes[0], node);
  assert.notEqual(first.nodes, second.nodes);
  assert.equal(first.screen, 'first');
  assert.equal(second.screen, 'second');
});

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

test('container text channels register without appearance variants', async () => {
  const screen = { name: 'grave', host: { kind: 'entity', type: 'example:grave' }, looks: [], texts: [0, 1] };
  const { registrations } = await evaluate([screen], [{ name: 'grave', source: './grave.screen.tsx' }]);
  const [[, component]] = registrations.metadata;

  assert.deepEqual(registrations.looks, [[component, [], [0, 1]]]);
});
