import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installUi } from '../../../test-support/ui.js';
import { bundleUiLibrary, bundleUiModule } from '../src/bundle.ts';
import { UiEvaluator } from '../src/evaluate.ts';

const canonical = '@bedrock-core/ore-styled';
const facade = '@bedrock-core/ui/ore-styled';
const token = value => `export const styleToken = ${JSON.stringify(value)};`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-styled-library-'));
  const evaluators = [];

  t.after(async () => {
    await Promise.all(evaluators.map(evaluator => evaluator.close()));
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^builder-styled-library-/);
    await rm(root, { recursive: true, force: true });
  });
  await installUi(root);
  const ui = path.join(root, 'node_modules/@bedrock-core/ui');
  const canonicalFile = path.join(root, 'node_modules/@bedrock-core/ore-styled/index.js');
  const facadeFile = path.join(ui, 'styled.js');
  const aliases = {};

  async function styled(source, directory = root) {
    const folder = path.join(directory, 'node_modules/@bedrock-core/ore-styled');

    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: canonical, type: 'module', exports: './index.js' }));
    await writeFile(path.join(folder, 'index.js'), source);

    return path.join(folder, 'index.js');
  }

  async function surface(source) {
    const file = path.join(ui, 'package.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));

    manifest.exports['./ore-styled'] = './styled.js';
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(facadeFile, source);
  }

  return {
    root, ui, aliases, styled, surface, canonicalFile, facadeFile,
    async alias(specifier, value) {
      const file = path.join(root, specifier === canonical ? 'canonical-alias.js' : 'facade-alias.js');

      aliases[specifier] = file;
      await writeFile(file, token(value));
    },
    async toolkit() {
      const options = { root, dependencyRoot: root, aliases };
      const library = await bundleUiLibrary(options);
      const file = path.join(root, 'library.mjs');

      await writeFile(file, library.code);
      const evaluator = new UiEvaluator({ library: file });

      evaluators.push(evaluator);
      const exports = await evaluator.request({ kind: 'exports' });

      return {
        library, exports,
        async screen(name, source) {
          const entry = path.join(root, `${name}.tsx`);
          const module = path.join(root, `${name}.mjs`);

          await writeFile(entry, source);
          const bundle = await bundleUiModule({ ...options, source: entry, exports });

          await writeFile(module, bundle.code);
          const screen = await evaluator.request({ kind: 'screen', module, name, namespace: 'styled' });

          return { bundle, screen, value: screen.document.root.fixture };
        },
      };
    },
  };
}

const one = specifier => `import { styleToken } from ${JSON.stringify(specifier)}; export default function Page() { return { kind: 'form', styleToken }; }`;
const both = `import { styleToken as canonicalToken } from '${canonical}'; import { styleToken as facadeToken } from '${facade}'; export default function Page() { return { kind: 'form', canonicalToken, facadeToken }; }`;

test('missing optional styled surfaces leave ordinary UI usable and named imports fail clearly', async (t) => {
  const project = await fixture(t);
  const toolkit = await project.toolkit();
  const result = await toolkit.screen('plain', 'export default function Page() { return { kind: \'form\', plain: true }; }');

  assert.equal(result.value.plain, true);
  assert.deepEqual(toolkit.exports.oreStyled, []);
  assert.deepEqual(toolkit.exports.oreStyledFacade, []);
  assert(toolkit.library.inputs.includes(path.join(project.root, 'node_modules/@bedrock-core/ore-styled/package.json')));
  await assert.rejects(toolkit.screen('canonical_missing', one(canonical)), /Could not resolve/);
  await assert.rejects(toolkit.screen('facade_missing', one(facade)), /Could not resolve/);
});

test('a canonical-only styled package is shared independently of the UI facade', async (t) => {
  const project = await fixture(t);

  await project.styled(token('canonical'));
  const toolkit = await project.toolkit();
  const result = await toolkit.screen('canonical', one(canonical));

  assert.equal(result.value.styleToken, 'canonical');
  assert.deepEqual(toolkit.exports.oreStyled, ['styleToken']);
  assert.deepEqual(toolkit.exports.oreStyledFacade, []);
  assert(!result.bundle.inputs.includes(project.canonicalFile));
  await assert.rejects(toolkit.screen('facade_missing', one(facade)), /Could not resolve/);
});

test('a facade-only styled surface is shared without a canonical root package', async (t) => {
  const project = await fixture(t);

  await project.surface(token('facade'));
  const toolkit = await project.toolkit();
  const result = await toolkit.screen('facade', one(facade));

  assert.equal(result.value.styleToken, 'facade');
  assert.deepEqual(toolkit.exports.oreStyled, []);
  assert.deepEqual(toolkit.exports.oreStyledFacade, ['styleToken']);
  assert(!result.bundle.inputs.includes(project.facadeFile));
  await assert.rejects(toolkit.screen('canonical_missing', one(canonical)), /Could not resolve/);
});

test('a facade resolves its nested styled dependency and shares it between screens', async (t) => {
  const project = await fixture(t);
  const nested = await project.styled(token('nested'), project.ui);

  await project.surface(`export * from '${canonical}';`);
  const toolkit = await project.toolkit();

  assert.deepEqual(toolkit.exports.oreStyled, []);
  assert.deepEqual(toolkit.exports.oreStyledFacade, ['styleToken']);
  assert(toolkit.library.inputs.includes(nested));

  for (const name of ['first', 'second']) {
    const result = await toolkit.screen(name, one(facade));

    assert.equal(result.value.styleToken, 'nested');
    assert(!result.bundle.inputs.includes(nested));
  }
});

test('canonical and facade surfaces retain distinct installed implementations', async (t) => {
  const project = await fixture(t);
  const nested = await project.styled(token('facade-v2'), project.ui);

  await project.styled(token('canonical-v1'));
  await project.surface('export * from \'./node_modules/@bedrock-core/ore-styled/index.js\';');
  const toolkit = await project.toolkit();
  const result = await toolkit.screen('versions', both);

  assert.equal(result.value.canonicalToken, 'canonical-v1');
  assert.equal(result.value.facadeToken, 'facade-v2');
  assert(!result.bundle.inputs.includes(project.canonicalFile));
  assert(!result.bundle.inputs.includes(project.facadeFile));
  assert(!result.bundle.inputs.includes(nested));
});

for (const aliased of [[canonical], [facade], [canonical, facade]]) {
  test(`styled aliases preserve both spellings independently: ${aliased.join(', ')}`, async (t) => {
    const project = await fixture(t);

    await project.styled(token('canonical-installed'));
    await project.surface(token('facade-installed'));

    for (const specifier of aliased) {
      await project.alias(specifier, specifier === canonical ? 'canonical-alias' : 'facade-alias');
    }

    const toolkit = await project.toolkit();
    const result = await toolkit.screen('aliases', both);

    assert.equal(Object.hasOwn(toolkit.exports, 'oreStyled'), false);
    assert.equal(Object.hasOwn(toolkit.exports, 'oreStyledFacade'), false);
    assert.equal(result.value.canonicalToken, aliased.includes(canonical) ? 'canonical-alias' : 'canonical-installed');
    assert.equal(result.value.facadeToken, aliased.includes(facade) ? 'facade-alias' : 'facade-installed');

    for (const file of Object.values(project.aliases)) {
      assert(result.bundle.inputs.includes(file));
    }
  });
}

test('an installed facade with a broken styled dependency fails instead of becoming optional', async (t) => {
  const project = await fixture(t);

  await project.surface(`export * from '${canonical}';`);
  await assert.rejects(project.toolkit(), /Could not resolve/);
});

test('both styled spellings share the same resolved factory identity', async (t) => {
  const project = await fixture(t);

  await project.styled('export const factory = {};');
  await project.surface(`export * from '${canonical}';`);
  const toolkit = await project.toolkit();
  const result = await toolkit.screen('identity', `import { factory as first } from '${canonical}'; import { factory as second } from '${facade}'; export default function Page() { return { kind: 'form', same: first === second }; }`);

  assert.equal(result.value.same, true);
  assert(!result.bundle.inputs.includes(project.canonicalFile));
  assert(!result.bundle.inputs.includes(project.facadeFile));
});
