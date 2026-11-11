import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { manifestFor } from '../test-support/manifest.js';
import { installUi } from '../test-support/ui.js';
import { runBuild } from '../src/run.ts';
import { run as runUi } from '../packages/ui-compiler/src/plugin.ts';

const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-ui-test-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await installUi(root);
  await mkdir(path.join(root, 'packs/BP/scripts'), { recursive: true });
  await mkdir(path.join(root, 'packs/RP/ui'), { recursive: true });
  const resource = manifestFor('resources');
  const behavior = manifestFor('script', 'scripts/start.ts');

  behavior.namespace = 'test';

  behavior.dependencies = [{ uuid: resource.header.uuid, version: resource.header.version }];
  await writeFile(path.join(root, 'packs/BP/manifest.json'), JSON.stringify(behavior));
  await writeFile(path.join(root, 'packs/RP/manifest.json'), JSON.stringify(resource));
  await writeFile(path.join(root, 'packs/BP/scripts/start.ts'), 'export const value = 1;');
  const config = {
    name: 'UI', authors: [], targetVersion: '1.26.50',
    packs: { logic: './packs/BP', assets: './packs/RP' },
    bedrockCore: { formatVersion: '1.0.0', profiles: { default: { export: { logic: './dist/BP', assets: './dist/RP' } } } },
  };
  const configPath = path.join(root, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return {
    root, config, configPath,
    options: { configPath, logger: {} },
    async save() { await writeFile(configPath, JSON.stringify(config)); },
    async screen(name, body = '<Text>Hello</Text>', prefix = '', directory = 'scripts') {
      const file = path.join(root, `packs/BP/${directory}/${name}.screen.tsx`);

      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `import { Screen, Text } from '@bedrock-core/ui'; ${prefix} export default function Page() { return <Screen>${body}</Screen>; }`);

      return file;
    },
  };
}

const screenChecks = result => result.compilations.filter(item => item.id.startsWith('ui-compiler/screen:'));
const executed = result => screenChecks(result).filter(item => item.status === 'executed').map(item => item.id.split(':').at(-1)).sort();

test('automatically marks ordinary components in build evaluation and shipped code', async (t) => {
  const project = await fixture(t);
  const source = await project.screen('cached', '<Row label="One" />', 'import { Button, useState } from "@bedrock-core/ui"; export function Row({ label }) { return <Text>{label}</Text>; } export function Handler({ onPress }) { return <Button onPress={onPress} />; } export function Events({ value }) { return <Handler onPress={() => value} />; } export function Derived({ prefix }) { const [count] = useState(1); const label = `${prefix}:${count}`; return <Text>{label}</Text>; }');
  const original = await readFile(source, 'utf8');

  await writeFile(path.join(project.root, 'packs/BP/scripts/start.ts'), 'export { Row, Events, Handler, Derived } from "./cached.screen";');
  project.config.bedrockCore.profiles.default.stages = { bundler: true };
  await project.save();
  let modules = [];
  const result = await runBuild({ ...project.options, stages: {
    'ui-compiler': async (context, settings) => {
      const result = await runUi(context, settings);
      const directory = path.join(context.generatedDir, 'ui');
      const files = (await readdir(directory)).filter(file => file.startsWith('module-') && file.endsWith('.mjs'));

      modules = await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')));

      return result;
    },
  } });

  assert(modules.some(code => code.includes('@bedrock-core/ui/compiler/pure')));
  assert(modules.some(code => code.includes('__cacheCallback')));
  assert(modules.some(code => code.includes('__cacheValue')));
  assert(modules.some(code => code.includes('@bedrock-core/ui/compiler/callback-props')));
  const output = await readFile(path.join(result.outputPaths.logic, 'scripts/start.js'), 'utf8');

  assert.match(output, /@bedrock-core\/ui\/compiler\/pure/);
  assert.match(output, /__cacheCallback/);
  assert.match(output, /__cacheValue/);
  assert.match(output, /@bedrock-core\/ui\/compiler\/callback-props/);
  const executable = path.join(project.root, 'verify-cache.mjs');

  await writeFile(executable, output);
  const previousScreens = globalThis.uiScreens;

  try {
    globalThis.uiScreens = [];
    const module = await import(pathToFileURL(executable));

    assert.equal(module.Row[Symbol.for('@bedrock-core/ui/compiler/pure')], true);
    assert.deepEqual(module.Handler[Symbol.for('@bedrock-core/ui/compiler/callback-props')], ['onPress']);
    assert.equal(module.Events({ value: 'latest' }).props.onPress(), 'latest');
    assert.equal(module.Derived({ prefix: 'Rows' }).props.children, 'Rows:1');
  } finally {
    if (previousScreens === undefined) {
      delete globalThis.uiScreens;
    } else {
      globalThis.uiScreens = previousScreens;
    }
  }

  assert.equal(await readFile(source, 'utf8'), original);
});

test('test metadata requires an artifact-finalizing host', async (t) => {
  const project = await fixture(t);

  await project.screen('host');
  project.config.bedrockCore.profiles.default.stages = { 'ui-compiler': { testMetadata: true } };
  await project.save();
  await assert.rejects(runBuild({ ...project.options, stages: {
    'ui-compiler': (context, settings) => runUi({ ...context, finalizeArtifact: undefined }, settings),
  } }), /artifact finalization support/);
});

test('invalid plugin metadata prevents publication', async (t) => {
  const project = await fixture(t);

  await project.screen('metadata');
  project.config.bedrockCore.plugins = { invalid: { module: './invalid.ts' } };
  project.config.bedrockCore.profiles.default.stages = { 'ui-compiler': { testMetadata: true } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'invalid', before: 'export' }];
  await writeFile(path.join(project.root, 'invalid.ts'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run(context) {
      await writeFile(path.join(context.packs.assets, 'bedrock-core/test-metadata.json'), '[]');
    }
  `);
  await project.save();
  await assert.rejects(runBuild(project.options), /Invalid UI test metadata manifest/);
});

for (const [pretty, plugin] of [false, { indent: 'space', size: 2 }, { indent: 'tab' }].flatMap(pretty => ['module', 'script'].map(plugin => [pretty, plugin]))) {
  test(`metadata hashes describe final ${plugin} plugin output with ${JSON.stringify(pretty)} formatting`, async (t) => {
    const project = await fixture(t);

    await project.screen('digest', '<Text>Authored</Text>', '', 'ui');
    project.config.bedrockCore.plugins = { decorate: { [plugin]: './decorate.mjs' } };
    project.config.bedrockCore.profiles.default.pretty = pretty;
    project.config.bedrockCore.profiles.default.stages = { 'ui-compiler': { testMetadata: true } };
    project.config.bedrockCore.profiles.default.steps = [{ plugin: 'decorate', before: 'export' }];
    await writeFile(path.join(project.root, 'decorate.mjs'), `
      import { readFile, writeFile, unlink } from 'node:fs/promises';
      import path from 'node:path';
      export async function run(context) {
        const root = context.packs.assets;
        const screen = path.join(root, 'ui/core-ui/screens/test/digest.json');
        const document = JSON.parse(await readFile(screen, 'utf8'));
        document.plugin = { decorated: true };
        await writeFile(screen, JSON.stringify(document, null, 4) + '\\n');
        await writeFile(path.join(root, 'ui/plugin-added.json'), '{"namespace":"plugin"}');
        await unlink(path.join(root, 'ui/discard.json'));
        const sidecar = path.join(root, 'bedrock-core/test-metadata.json');
        const metadata = JSON.parse(await readFile(sidecar, 'utf8'));
        metadata.extension = 'preserved';
        await writeFile(sidecar, JSON.stringify(metadata));
      }
      ${plugin === 'script' ? 'await run({ packs: { assets: path.resolve(\'RP\') } });' : ''}
    `);
    await writeFile(path.join(project.root, 'packs/RP/ui/discard.json'), '{"namespace":"discard"}');
    await project.save();

    for (const status of ['executed', 'cached']) {
      const result = await runBuild(project.options);
      const metadata = await json(path.join(result.outputPaths.assets, 'bedrock-core/test-metadata.json'));

      assert.equal(result.stages.find(stage => stage.stage === 'ui-compiler').status, status);
      assert.equal(metadata.extension, 'preserved');
      assert.equal(metadata.screens.find(screen => screen.metadata)?.source, 'packs/BP/ui/digest.screen.tsx');
      assert.ok(metadata.files.some(file => file.path === 'ui/plugin-added.json'));
      assert.ok(!metadata.files.some(file => file.path === 'ui/discard.json'));

      for (const file of metadata.files) {
        const actual = createHash('sha256').update(await readFile(path.join(result.outputPaths.assets, file.path))).digest('hex');

        assert.equal(file.sha256, actual, file.path);
      }
    }
  });
}

test('pack UI sources share runtime imports, editor keys and cached output with script screens', async (t) => {
  const project = await fixture(t);

  t.after(() => {
    delete globalThis.uiScreens;
    delete globalThis.authoredUi;
  });
  const source = await project.screen('current', '<Text>{caption}</Text>', 'import caption from \'@ui/caption\';', 'ui');
  const caption = path.join(project.root, 'packs/BP/ui/caption.ts');
  const entry = path.join(project.root, 'packs/BP/scripts/start.ts');

  await project.screen('legacy', '<Text>Legacy</Text>', '', 'scripts/UI');
  await writeFile(caption, 'import { suffix } from \'../scripts/shared\'; export default \'Current \' + suffix;');
  await writeFile(path.join(project.root, 'packs/BP/ui/unused.ts'), 'export default { private: true };');
  await writeFile(path.join(project.root, 'packs/BP/scripts/shared.ts'), 'export const suffix = \'caption\';');
  await writeFile(path.join(project.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    paths: { '@ui/*': ['./packs/BP/ui/*'] }, jsx: 'react-jsx', jsxImportSource: '@bedrock-core/ui',
  } }));
  await writeFile(entry, `import Page from '../ui/current.screen'; import { render } from '@bedrock-core/ui'; globalThis.authoredUi = render(Page);`);
  const original = await readFile(source, 'utf8');

  for (const expected of ['executed', 'cached']) {
    const result = await runBuild(project.options);
    const script = path.join(project.root, `verify-ui-${expected}.mjs`);

    assert.equal(result.stages.find(stage => stage.stage === 'generator').status, 'skipped');
    assert.equal(result.stages.find(stage => stage.stage === 'ui-compiler').status, expected);
    assert.match(await readFile(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/current.json'), 'utf8'), /Current caption/);
    assert.match(await readFile(path.join(project.root, '.bedrock-core/generated/ui/screens.generated.d.ts'), 'utf8'), /"test:current": true/);
    await assert.rejects(readdir(path.join(result.outputPaths.logic, 'ui')), { code: 'ENOENT' });
    assert.equal(await readFile(source, 'utf8'), original);
    await writeFile(script, await readFile(path.join(result.outputPaths.logic, 'scripts/start.js')));
    await import(pathToFileURL(script));
    assert.deepEqual([...globalThis.uiScreens].sort(), ['test:current', 'test:legacy']);
    assert.equal(globalThis.authoredUi.children.text, 'Current caption');
    delete globalThis.uiScreens;
    delete globalThis.authoredUi;
  }

  await writeFile(caption, 'export default \'Updated caption\';');
  assert.deepEqual(executed(await runBuild(project.options)), ['current']);
  await rm(source);
  await writeFile(entry, 'export const value = 1;');
  const removed = await runBuild(project.options);

  assert.doesNotMatch(await readFile(path.join(project.root, '.bedrock-core/generated/ui/screens.generated.d.ts'), 'utf8'), /test:current/);
  await assert.rejects(readFile(path.join(removed.outputPaths.assets, 'ui/core-ui/screens/test/current.json')), { code: 'ENOENT' });
});

test('duplicate screen names across UI and scripts fail before export', async (t) => {
  const project = await fixture(t);

  await project.screen('duplicate');
  await project.screen('duplicate', '<Text>Duplicate</Text>', '', 'ui');
  await assert.rejects(runBuild(project.options), /Two UI screens are named duplicate/);
});

test('isolates host detection between component roots with retained state', async (t) => {
  const project = await fixture(t);
  const compile = path.join(project.root, 'node_modules/@bedrock-core/ui-runtime/compile.js');
  const source = await readFile(compile, 'utf8');

  await writeFile(compile, source.replace('export const buildScreenOnce = render;', `
    let retained;
    export const buildScreenOnce = component => {
      if (retained && retained !== component) { throw new Error('Host probe retained another screen root'); }
      retained = component;
      return render(component);
    };
  `));
  await project.screen('first', '<Text>First root</Text>');
  await project.screen('second', '<Text>Second root</Text>');
  const result = await runBuild(project.options);

  assert.deepEqual(executed(result), ['first', 'second']);
  assert.match(await readFile(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/first.json'), 'utf8'), /First root/);
  assert.match(await readFile(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/second.json'), 'utf8'), /Second root/);
});

test('automatically compiles UI and registers it in the manifest entry without source edits', async (t) => {
  const project = await fixture(t);

  await project.screen('hello');
  await project.screen('subpath', '<ContainerText>Shared owner</ContainerText>', 'import { Text as ContainerText } from \'@bedrock-core/ui-runtime/container\';');
  await writeFile(path.join(project.root, 'packs/RP/ui/_ui_defs.json'), '// authored\n{"ui_defs":["ui/authored.json"]}');
  await writeFile(path.join(project.root, 'packs/RP/ui/authored.json'), '{"namespace":"authored"}');
  const result = await runBuild(project.options);
  const source = await readFile(path.join(project.root, 'packs/BP/scripts/start.ts'), 'utf8');
  const output = path.join(result.outputPaths.logic, 'scripts/start.js');
  const executable = path.join(project.root, 'verify.mjs');

  assert.equal(source, 'export const value = 1;');
  await writeFile(executable, await readFile(output));
  await import(pathToFileURL(executable));
  assert.deepEqual(globalThis.uiScreens, ['test:hello', 'test:subpath']);
  delete globalThis.uiScreens;
  const defs = (await json(path.join(result.outputPaths.assets, 'ui/_ui_defs.json'))).ui_defs;

  assert.ok(defs.includes('ui/authored.json'));
  assert.ok(defs.includes('ui/core-ui/screens/test/hello.json'));
  assert.deepEqual(executed(result), ['hello', 'subpath']);
});

test('omits compiled pack-local UI sources from cold and cached exports', async (t) => {
  const project = await fixture(t);
  const scripts = path.join(project.root, 'packs/BP/scripts');
  const screen = await project.screen('static', '<Text>{caption}</Text>', 'import { caption } from \'./nested/caption\';');
  const sources = {
    'static.screen.tsx': await readFile(screen, 'utf8'),
    'nested/caption.ts': 'export { caption } from \'./label\';',
    'nested/label.tsx': 'export const caption = \'Static caption\';',
  };

  await mkdir(path.join(scripts, 'nested'));

  for (const [file, content] of Object.entries(sources)) {
    await writeFile(path.join(scripts, file), content);
  }

  await writeFile(path.join(scripts, 'custom.js'), 'export const custom = true;');
  await writeFile(path.join(scripts, 'data.json'), '{"value":7}');

  for (const expected of ['executed', 'cached']) {
    const result = await runBuild(project.options);

    assert.equal(result.stages.find(step => step.stage === 'ui-compiler').status, expected);
    assert.equal(result.stages.find(step => step.stage === 'bundler').status, expected);
    assert.match(await readFile(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/static.json'), 'utf8'), /Static caption/);
    assert.match(await readFile(path.join(result.outputPaths.logic, 'scripts/start.js'), 'utf8'), /test:static/);
    assert.equal(await readFile(path.join(result.outputPaths.logic, 'scripts/custom.js'), 'utf8'), 'export const custom = true;');
    assert.deepEqual(await json(path.join(result.outputPaths.logic, 'scripts/data.json')), { value: 7 });

    for (const [file, content] of Object.entries(sources)) {
      await assert.rejects(readFile(path.join(result.outputPaths.logic, 'scripts', file)), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(scripts, file), 'utf8'), content);
    }
  }
});

test('reuses screens across builds and recompiles only consumers of an imported helper or JSON', async (t) => {
  const project = await fixture(t);
  const helper = path.join(project.root, 'packs/BP/scripts/helper.ts');
  const data = path.join(project.root, 'packs/BP/scripts/data.json');

  await writeFile(helper, 'export const text = \'First\';');
  await writeFile(data, '{"text":"Data"}');
  await project.screen('one', '<Text>{text}</Text>', 'import { text } from \'./helper\';');
  await project.screen('two', '<Text>{text}</Text>', 'import { text } from \'./helper\';');
  await project.screen('three', '<Text>{data.text}</Text>', 'import data from \'./data.json\';');
  await runBuild(project.options);
  const warm = await runBuild(project.options);

  assert.deepEqual(executed(warm), []);
  await writeFile(path.join(project.root, 'packs/BP/scripts/start.ts'), 'export const value = 2;');
  assert.deepEqual(executed(await runBuild(project.options)), []);
  await writeFile(helper, 'export const text = \'Second\';');
  assert.deepEqual(executed(await runBuild(project.options)), ['one', 'two']);
  await writeFile(data, '{"text":"Changed"}');
  const changed = await runBuild(project.options);

  assert.deepEqual(executed(changed), ['three']);
  assert.match(await readFile(path.join(changed.outputPaths.assets, 'ui/core-ui/screens/test/three.json'), 'utf8'), /Changed/);
  await rm(path.join(project.root, 'packs/BP/scripts/two.screen.tsx'));
  const removed = await runBuild(project.options);

  assert.deepEqual(executed(removed), []);
  await assert.rejects(readFile(path.join(removed.outputPaths.assets, 'ui/core-ui/screens/test/two.json')), { code: 'ENOENT' });
  const router = await json(path.join(removed.outputPaths.assets, 'ui/core-ui/screens/test_forms.json'));

  assert.deepEqual(router.names, ['one', 'three']);
});

test('toolkit changes, output formatting and profile cache controls invalidate the appropriate work', async (t) => {
  const project = await fixture(t);

  await project.screen('hello');
  project.config.bedrockCore.profiles.default.stages = { 'ui-compiler': { testMetadata: true } };
  await project.save();
  await runBuild(project.options);
  project.config.bedrockCore.profiles.default.stages['ui-compiler'].pretty = { size: 2 };
  await project.save();
  const formatted = await runBuild(project.options);

  assert.deepEqual(executed(formatted), []);
  const metadata = await json(path.join(formatted.outputPaths.assets, 'bedrock-core/test-metadata.json'));

  for (const file of metadata.files) {
    const actual = createHash('sha256').update(await readFile(path.join(formatted.outputPaths.assets, file.path))).digest('hex');

    assert.equal(file.sha256, actual);
  }

  const compiler = path.join(project.root, 'node_modules/@bedrock-core/ui-compiler/index.js');

  await writeFile(compiler, `${await readFile(compiler, 'utf8')}\nexport const revision = 2;`);
  assert.deepEqual(executed(await runBuild(project.options)), ['hello']);
  project.config.bedrockCore.profiles.default.cache = false;
  await project.save();
  assert.deepEqual(executed(await runBuild(project.options)), ['hello']);
});

test('runtime Node reads evaluate freshly while compiled modules are reused', async (t) => {
  const project = await fixture(t);
  const file = path.join(project.root, 'runtime.txt');

  await writeFile(file, 'First');
  await project.screen('runtime', '<Text>{text}</Text>', `import { readFileSync } from 'node:fs'; const text = readFileSync(${JSON.stringify(file)}, 'utf8');`);
  await runBuild(project.options);
  await writeFile(file, 'Second');
  const result = await runBuild(project.options);

  assert.deepEqual(executed(result), ['runtime']);
  assert.equal(result.compilations.find(item => item.id.includes('module:packs/BP/scripts/runtime')).status, 'cached');
  assert.match(await readFile(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/runtime.json'), 'utf8'), /Second/);
});

test('module records, container hosts and multiple resource packs retain complete outputs on cache hits', async (t) => {
  const project = await fixture(t);

  await writeFile(path.join(project.root, 'screens.tsx'), `import { Screen, Text } from '@bedrock-core/ui'; export default { record: () => <Screen><Text>Record</Text></Screen> };`);
  await writeFile(path.join(project.root, 'packs/BP/scripts/host.screen.tsx'), `import { Container, Text } from '@bedrock-core/ui'; export default function Host() { return <Container host={{ kind: 'entity', type: 'test:host' }}><Text>Host</Text></Container>; }`);
  await mkdir(path.join(project.root, 'packs/BP/entities'));
  await writeFile(path.join(project.root, 'packs/BP/entities/host.json'), JSON.stringify({ 'format_version': '1.21.120', 'minecraft:entity': { description: { identifier: 'test:host' } } }));
  await mkdir(path.join(project.root, 'packs/RP2'));
  await writeFile(path.join(project.root, 'packs/RP2/manifest.json'), JSON.stringify(manifestFor('resources')));
  project.config.packs.extra = './packs/RP2';
  project.config.bedrockCore.profiles.default.export.extra = './dist/RP2';
  project.config.bedrockCore.profiles.default.stages = { 'ui-compiler': { screens: ['./screens.tsx'], testMetadata: true, stamp: true } };
  await project.save();
  await runBuild(project.options);
  const result = await runBuild(project.options);

  assert.deepEqual(executed(result), []);

  for (const id of ['assets']) {
    const pack = result.outputPaths[id];

    assert.equal((await json(path.join(pack, 'bedrock-core/test-metadata.json'))).screens.length, 2);
    assert.equal((await json(path.join(pack, 'ui/hud_screen.json'))).root_panel.modifications.length, 1);
    assert.ok((await json(path.join(pack, 'ui/core-ui/screens/test/core_build.json'))).stamp.text.startsWith('ui '));
  }

  await assert.rejects(readFile(path.join(result.outputPaths.extra, 'ui/_ui_defs.json')), { code: 'ENOENT' });

  const host = (await json(path.join(result.outputPaths.logic, 'entities/host.json')))['minecraft:entity'];

  assert.equal(host.components['minecraft:inventory'].inventory_size, 9);
  assert.equal(host.description.properties['fixture:layout'].default, 2);
  assert.equal((await json(path.join(result.outputPaths.logic, 'items/core-ui/test/fixture.json')))['minecraft:item'].description.identifier, 'test:fixture');
});

for (const location of ['entry', 'imported module', 'GameTest entry']) {
  test(`manifest declarations in ${location} include default and shaped app screens`, async (t) => {
    const project = await fixture(t);
    const server = path.join(project.root, 'node_modules/@bedrock-core/server-runtime');
    const app = path.join(project.root, 'node_modules/fixture-app');

    await mkdir(server, { recursive: true });
    await mkdir(app, { recursive: true });
    await writeFile(path.join(server, 'package.json'), '{"name":"@bedrock-core/server-runtime","type":"module","exports":"./index.js"}');
    await writeFile(path.join(server, 'index.js'), 'export const core = { register() {} };');
    await writeFile(path.join(app, 'package.json'), '{"name":"fixture-app","type":"module","exports":"./screens.tsx"}');
    await writeFile(path.join(app, 'screens.tsx'), `
    import { Screen, Text } from '@bedrock-core/ui';
    export default { home: () => <Screen><Text>Home</Text></Screen> };
    export function shape(declared, manifest) {
      if (manifest.namespace !== 'test' || manifest.metadata.authors[0] !== 'Fixture' || manifest.header.version !== '1.0.0') throw new Error('Authored manifest metadata was not retained');
      return { [declared.page]: () => <Screen><Text>{manifest.header.name}</Text></Screen> };
    }
  `);
    const entry = path.join(project.root, 'packs/BP/scripts/start.ts');
    const registration = location === 'entry' ? entry : path.join(project.root, 'packs/BP/scripts/registration.ts');

    if (registration !== entry) {
      await writeFile(entry, `import './registration';`);
    }

    if (location === 'GameTest entry') {
      const gametest = path.join(project.root, 'node_modules/@minecraft/server-gametest');

      await mkdir(gametest, { recursive: true });
      await writeFile(path.join(gametest, 'package.json'), '{"name":"@minecraft/server-gametest","types":"index.d.ts"}');
      await writeFile(path.join(gametest, 'index.d.ts'), 'export function register(namespace: string, name: string, test: () => void): void;');
      await writeFile(entry, `import './registration'; import { register } from '@minecraft/server-gametest'; register('fixture', 'ready', () => {});`);
    }

    const declaredManifest = { ...manifestFor('script'), namespace: 'test', metadata: { authors: ['Fixture'] } };

    declaredManifest.header.name = 'First';
    declaredManifest.header.version = '1.0.0';

    await writeFile(registration, `import { core } from '@bedrock-core/server-runtime'; core.register({ manifest: ${JSON.stringify(declaredManifest)}, feature: { app: 'fixture', compiled: 'fixture-app', page: 'declared' } });`);
    project.config.bedrockCore.profiles.default.stages = { 'ui-compiler': { testMetadata: true } };
    await project.save();
    const initial = await runBuild(project.options);

    assert.deepEqual(executed(initial), ['declared', 'home']);
    assert.match(await readFile(path.join(initial.outputPaths.assets, 'ui/core-ui/screens/test/declared.json'), 'utf8'), /First/);
    const metadata = await json(path.join(initial.outputPaths.assets, 'bedrock-core/test-metadata.json'));

    assert.equal(metadata.screens.find(screen => screen.file.endsWith('/declared.json')).source, 'packs/BP/scripts/start.ts');
    assert.equal(metadata.screens.find(screen => screen.file.endsWith('/home.json')).source, 'fixture-app');
    assert.deepEqual(executed(await runBuild(project.options)), []);
    declaredManifest.header.name = 'Second';
    await writeFile(registration, `import { core } from '@bedrock-core/server-runtime'; core.register({ manifest: ${JSON.stringify(declaredManifest)}, feature: { app: 'fixture', compiled: 'fixture-app', page: 'declared' } });`);
    const changed = await runBuild(project.options);

    assert.deepEqual(executed(changed), ['declared']);
    assert.match(await readFile(path.join(changed.outputPaths.assets, 'ui/core-ui/screens/test/declared.json'), 'utf8'), /Second/);
  });
}

test('removing the last screen refreshes editor keys and removes generated UI from the exported pack', async (t) => {
  const project = await fixture(t);
  const source = await project.screen('last', '<Text>Hello</Text>', '', 'ui');

  await runBuild(project.options);
  await rm(source);
  const result = await runBuild(project.options);

  await assert.rejects(readFile(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/last.json')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(path.join(project.root, '.bedrock-core/generated/ui/screens.generated.d.ts'), 'utf8'), /test:last/);
});

test('navigation factories, host extensions, UI facade and Core adapter share one runtime', async (t) => {
  const project = await fixture(t);
  const navigation = path.join(project.root, 'node_modules/@bedrock-core/navigation');
  const uiPackage = path.join(project.root, 'node_modules/@bedrock-core/ui/package.json');
  const metadata = await json(uiPackage);

  await mkdir(navigation, { recursive: true });
  await writeFile(path.join(navigation, 'package.json'), JSON.stringify({
    name: '@bedrock-core/navigation', type: 'module', exports: { '.': './index.js', './core': './core.js', './runtime': './runtime.js' },
  }));
  await writeFile(path.join(navigation, 'index.js'), `
    import { Text } from '@bedrock-core/ui-runtime';
    let declaration;
    export const registerDeclared = value => { declaration = value; };
    export const pageTargeted = () => Text({ children: declaration });
  `);
  await writeFile(path.join(navigation, 'core.js'), 'export { registerDeclared as registerCore } from \'./index.js\';');
  await writeFile(path.join(navigation, 'runtime.js'), 'export { registerDeclared as registerRuntime } from \'./index.js\';');
  metadata.exports['./navigation'] = './navigation.js';
  await writeFile(uiPackage, JSON.stringify(metadata));
  await writeFile(path.join(path.dirname(uiPackage), 'navigation.js'), 'export * from \'@bedrock-core/navigation\';');
  await project.screen('navigation', '{pageTargeted()}', `
    import { registerDeclared } from '@bedrock-core/navigation';
    import { registerCore } from '@bedrock-core/navigation/core';
    import { registerRuntime } from '@bedrock-core/navigation/runtime';
    import { pageTargeted } from '@bedrock-core/ui/navigation';
    registerDeclared('Base navigation');
    registerCore('Shared navigation');
    registerRuntime('Shared navigator factory');
  `);
  const result = await runBuild(project.options);
  const output = await json(path.join(result.outputPaths.assets, 'ui/core-ui/screens/test/navigation.json'));

  assert.equal(output.root.fixture.children.text, 'Shared navigator factory');
});

test('navigation metadata retains public parameters and native host keys', async (t) => {
  const project = await fixture(t);

  await project.screen('detail', '<Text>Detail</Text>', 'export const parameters = { item: { type: \'string\' } };');
  const native = path.join(project.root, 'packs/BP/scripts/native.screen.tsx');

  await writeFile(native, `import { Container, Text } from '@bedrock-core/ui'; export default () => <Container host={{ kind: 'entity', type: 'test:native' }}><Text>Native</Text></Container>;`);
  await mkdir(path.join(project.root, 'packs/BP/entities'));
  await writeFile(path.join(project.root, 'packs/BP/entities/native.json'), JSON.stringify({ 'format_version': '1.21.120', 'minecraft:entity': { description: { identifier: 'test:native' } } }));
  let generated;

  await runBuild({ ...project.options, validateArtifacts: async (context) => {
    generated = await readFile(context.artifact('ui:bundle').path, 'utf8');
  } });

  assert.match(generated, /registerScreenMetadata\(.*"kind":"entity"/);
  assert.match(generated, /registerCompiledScreen\(.*"parameters":\{"item":\{"type":"string"\}\}/);
  assert.match(generated, /SCREEN_KEYS = \[.*"test:native"/);
  const types = await readFile(path.join(project.root, '.bedrock-core/generated/ui/screens.generated.d.ts'), 'utf8');

  assert.match(types, /"test:native": true/);
  assert.match(types, /declare module '@bedrock-core\/navigation'/);
});
