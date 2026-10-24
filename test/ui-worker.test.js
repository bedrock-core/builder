import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { UiEvaluator } from '../packages/ui-compiler/src/evaluate.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-ui-worker-'));
  const library = path.join(root, 'library.mjs');
  const module = path.join(root, 'screen.mjs');

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^builder-ui-worker-/);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(module, 'export default function Page() { return {}; }');
  await writeFile(library, `
    import { randomUUID } from 'node:crypto';
    import { constants } from 'node:buffer';
    export const guides = { [randomUUID()]: true };
    export const jsx = {};
    export const ui = {};
    export const i18n = { createI18n() {} };
    export const runtime = { buildScreenTree: page => page(), hostFor: () => ({ id: 'form' }), setBuildLocales() {},
      charsetLang: () => [], LAYOUT_PROPERTY: 'layout', MAX_LAYOUT: 100, BLOCK_SLOT_LIMIT: 54 };
    export const compiler = {
      compileFormScreen(_page, spec) {
        return { name: spec.name, addon: spec.namespace, namespace: spec.namespace + '_' + spec.name,
          document: { namespace: 'screen', screen: { type: 'panel', optional: undefined } }, faces: {}, facesNamespace: 'faces', hasBackdrop: false,
          title: 'Portable screen', snapshot: { shape: 'shape', baked: [], vis: [] },
          face: { document: { sourceOnly: true } }, entries: [{ element: { onPress() {} } }] };
      },
      buildUiPack(screens, namespace) {
        const shared = { text: 'x'.repeat(8 * 1024 * 1024) };
        const sections = Array(Math.floor(constants.MAX_STRING_LENGTH / shared.text.length) + 2).fill(shared);
        return { screens, hooks: [], documents: [{ file: namespace + '.json', document: { sections } }] };
      },
    };
  `);
  const evaluator = new UiEvaluator({ library });

  t.after(() => evaluator.close());

  return { evaluator, module };
}

test('transports emitted screen data without executable compiler source trees', async (t) => {
  const { evaluator, module } = await fixture(t);
  const screen = await evaluator.request({ kind: 'screen', module, name: 'page', namespace: 'test' });

  assert.deepEqual(screen.document, { namespace: 'screen', screen: { type: 'panel' } });
  assert.deepEqual(screen.snapshot, { shape: 'shape', baked: [], vis: [] });
  assert.equal(screen.title, 'Portable screen');
  assert.equal(screen.entryCount, 1);
  assert.equal(Object.hasOwn(screen, 'entries'), false);
  assert.equal(Object.hasOwn(screen, 'face'), false);
});

test('transports a linked collection whose JSON expansion exceeds the string limit', async (t) => {
  const { evaluator } = await fixture(t);
  const linked = await evaluator.request({ kind: 'link', screens: [], namespace: 'test' });
  const sections = linked.documents[0].document.sections;

  assert.ok(sections.length * sections[0].text.length > constants.MAX_STRING_LENGTH);
  assert.equal(sections[0].text.length, 8 * 1024 * 1024);
  assert.ok(sections.every(section => section === sections[0]));
});

test('reports worker failures and continues serving sequential requests', async (t) => {
  const { evaluator, module } = await fixture(t);

  await writeFile(module, 'export default 42;');
  await assert.rejects(evaluator.request({ kind: 'screen', module, name: 'invalid', namespace: 'test' }), /must export a component/);
  const first = await evaluator.request({ kind: 'exports' });

  for (let index = 0; index < 62; index++) {
    await evaluator.request({ kind: 'exports' });
  }

  const renewed = await evaluator.request({ kind: 'exports' });

  assert.notDeepEqual(renewed.guides, first.guides);
});
