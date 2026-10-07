import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A small addon-installed toolkit exercising the adapter's compiler/runtime contract. */
export async function installUi(root) {
  const packages = {
    'ui': {
      exports: { '.': './index.js', './jsx-runtime': './jsx.js', './jsx-dev-runtime': './jsx.js' },
      files: {
        'index.js': `
          export { Screen, Text, Container, render } from '@bedrock-core/ui-runtime';
          export const registerCompiledScreen = (screen, value) => { globalThis.uiScreens ??= []; globalThis.uiScreens.push(value.key); };
          export const registerStaticScreens = values => { globalThis.uiScreens ??= []; globalThis.uiScreens.push(...values.map(value => value.key)); };
          export const registerContainerLooks = () => {};
          export const addonReference = namespace => ({ namespace });
        `,
        'jsx.js': `
          export const jsx = (type, props) => ({ type, props });
          export const jsxs = jsx;
          export const jsxDEV = jsx;
          export const Fragment = props => props.children;
        `,
      },
    },
    'ui-runtime': {
      exports: { '.': './index.js', './compile': './compile.js', './container': './container.js' },
      files: {
        'index.js': `
          let owner;
          export const Screen = props => ({ ...props, kind: 'form' });
          export const Container = props => ({ ...props, kind: 'chest' });
          export const Text = props => { checkOwner(); return { text: props.children }; };
          export function render(component) {
            owner = true;
            try {
              const expand = node => typeof node?.type === 'function' ? expand(node.type(node.props))
                : Array.isArray(node) ? node.map(expand) : node && typeof node === 'object'
                  ? Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expand(value)])) : node;
              return expand(component());
            } finally { owner = false; }
          }
          export function checkOwner() { if (!owner) { throw new Error('UI runtime instances differ'); } }
        `,
        'compile.js': `
          import { render } from './index.js';
          export const buildScreenOnce = render;
          export const hostFor = tree => ({ id: tree.kind === 'chest' ? 'chest' : 'form' });
          export const setBuildLocales = () => {};
          export const charsetLang = () => ['fixture.charset=value'];
          export const LAYOUT_PROPERTY = 'fixture:layout';
          export const MAX_LAYOUT = 100;
          export const BLOCK_SLOT_LIMIT = 54;
          export const protocolItemDefinitions = namespace => [{ role: 'fixture', document: { format_version: '1.26.0', 'minecraft:item': { description: { identifier: namespace + ':fixture' } } } }];
        `,
        'container.js': 'export { Text, Container } from \'./index.js\';',
      },
    },
    'ui-compiler': {
      exports: './index.js',
      files: {
        'index.js': `
          import { render } from '@bedrock-core/ui-runtime';
          function compile(component, spec) {
            const tree = render(component);
            return {
              name: spec.name, addon: spec.namespace, namespace: spec.namespace + '_' + spec.name,
              document: { namespace: spec.namespace + '_' + spec.name, root: { type: 'panel', fixture: tree } },
              facesNamespace: spec.namespace + '_faces', faces: {}, face: { document: {} }, hasBackdrop: false,
              ...(tree.kind === 'chest' ? { host: tree.host, layoutId: 2, allocation: { size: 9 }, looks: ['fixture'], hasText: true }
                : { title: spec.name, ...(tree.live ? { snapshot: { shape: 'fixture', baked: [], vis: [] } } : { table: { values: [JSON.stringify(tree.children)], targets: [null] } }) }),
              ...(spec.testMetadata ? { testMetadata: { fixture: true } } : {}),
            };
          }
          export const compileScreen = compile;
          export const compileFormScreen = compile;
          export function buildUiPack(screens, namespace) {
            return { screens, hooks: [{ file: 'ui/server_form.json', document: { namespace: 'server_form', main_screen: { modifications: [] } } }],
              documents: [{ file: 'ui/core-ui/screens/' + namespace + '_forms.json', document: { namespace: namespace + '_forms', names: screens.map(screen => screen.name) } }] };
          }
        `,
      },
    },
    'i18n': { exports: './index.js', files: { 'index.js': 'export const createI18n = () => {};' } },
  };

  for (const [name, definition] of Object.entries(packages)) {
    const directory = path.join(root, 'node_modules/@bedrock-core', name);

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@bedrock-core/${name}`, type: 'module', exports: definition.exports }));

    for (const [file, content] of Object.entries(definition.files)) {
      await writeFile(path.join(directory, file), content);
    }
  }
}
