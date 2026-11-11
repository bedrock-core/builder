import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, rm, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { projectFor, put as putText } from '../test-support/project.js';
import { installFakeRuntime } from '../test-support/server-runtime.js';
import { runBuild } from '../src/run.ts';
import { bundleScripts } from '../packages/bundler/src/index.ts';
import { watchBuild } from '../src/watch.ts';

async function put(root, name, value) {
  return putText(root, name, typeof value === 'string' ? value : JSON.stringify(value));
}

const runtime = {
  source: `
    export const core = { register() {} };
    export function defineApiModule() {}
    export function createApiModule(namespace, name, shape) {
      function value(shape) {
        if (shape.kind === 'value') return shape.value;
        if (shape.kind === 'function') return async () => { throw new Error('API runtime unavailable during build'); };
        return Object.fromEntries(Object.entries(shape.members).map(([key, entry]) => [key, value(entry)]));
      }
      return value(shape);
    }
  `,
  client: `
    throw new Error('LIVE_API_CLIENT_LOADED');
    export { createApiModule as createClientApiModule } from './index.js';
  `,
};

async function fixture(t, options) {
  const project = await projectFor(t, options);

  await installFakeRuntime(project.project, runtime);
  await put(project.project, 'package.json', {
    name: 'portable-addon', version: '1.2.3', type: 'module', exports: {
      '.': './packs/gameplay/api/index.ts', './math': './packs/gameplay/api/math.ts', './manifest.json': './packs/gameplay/manifest.json',
    },
  });
  await put(project.project, 'packs/gameplay/api/index.ts', `import './init'; export async function read(input: string): Promise<string> { return 'PRIVATE_PROVIDER_BODY:' + input; } export const info = { revision: 1 } as const;`);
  await put(project.project, 'packs/gameplay/api/init.ts', 'throw new Error(\'PRIVATE_PROVIDER_INITIALIZATION\');');
  await put(project.project, 'packs/gameplay/api/math.ts', 'export async function twice(value: number): Promise<number> { return value * 2; }');
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import {core} from \'@bedrock-core/server-runtime\'; import manifest from \'../manifest.json\'; core.register({manifest});');
  project.config.bedrockCore.profiles.default.stages = { 'manifest': true, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false, 'bundler': true };
  project.save = () => put(project.project, 'config.json', project.config);
  await project.save();

  return project;
}

async function consumer(t, published, linked = false) {
  const project = await projectFor(t);

  await installFakeRuntime(project.project, runtime);
  const installed = path.join(project.project, 'node_modules/portable-addon');

  if (linked) {
    await symlink(published, installed, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    await cp(published, installed, { recursive: true });
  }

  project.behavior.namespace = 'portable_consumer';
  await put(project.project, 'package.json', { name: 'portable-consumer', type: 'module' });

  return project;
}

test('provider builds publish clients and public declarations with verified warm reuse', async (t) => {
  const project = await fixture(t);

  project.behavior.modules.find(module => module.type === 'script').entry = 'scripts/main.ts';
  await put(project.project, 'packs/gameplay/manifest.json', project.behavior);
  const cold = await runBuild({ configPath: project.configPath, logger: {} });
  const warm = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(cold.apiOutput, path.join(project.project, 'dist/api'));
  assert.equal(warm.compilations.find(item => item.id.endsWith('api:package')).status, 'cached');
  const metadata = JSON.parse(await readFile(path.join(cold.apiOutput, 'package.json'), 'utf8'));

  assert.equal(metadata.name, 'portable-addon');
  assert.equal(metadata.version, '1.2.3');
  assert.equal(metadata.bedrockCore.api.formatVersion, '1.0.0');
  assert.equal(metadata.bedrockCore.api.manifests['.'], metadata.bedrockCore.api.manifests['./math']);
  const client = await readFile(path.join(cold.apiOutput, metadata.exports['.'].import), 'utf8');
  const declarations = await readFile(path.join(cold.apiOutput, metadata.exports['.'].types), 'utf8');
  const manifestTypes = await readFile(path.join(cold.apiOutput, metadata.exports['./manifest.json'].types), 'utf8');

  assert.doesNotMatch(client, /PRIVATE_PROVIDER/);
  assert.doesNotMatch(declarations, /import ['"]\.\/init|PRIVATE_PROVIDER/);
  assert.match(manifestTypes, /"entry"\s*:\s*"scripts\/main\.js"/);
  await assert.rejects(readFile(path.join(cold.outputPaths.gameplay, 'api/index.ts')), { code: 'ENOENT' });
  await put(project.project, 'packs/gameplay/api/index.ts', 'export async function read(input: number): Promise<number> { return input; } export const info = { revision: 2 } as const;');
  const changed = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(changed.compilations.find(item => item.id.endsWith('api:package')).status, 'executed');
  assert.match(await readFile(path.join(changed.apiOutput, metadata.exports['.'].types), 'utf8'), /input: number/);
});

test('API declarations use the project JSX settings inherited through tsconfig', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'tsconfig.json', { extends: './ui.tsconfig.json' });
  await put(project.project, 'ui.tsconfig.json', { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'portable-ui' } });
  await put(project.project, 'node_modules/portable-ui/package.json', {
    name: 'portable-ui', version: '1.0.0', exports: { './jsx-runtime': './jsx-runtime.d.ts' },
  });
  await put(project.project, 'node_modules/portable-ui/jsx-runtime.d.ts', 'export namespace JSX { interface Element {} interface IntrinsicElements { label: {} } }');
  await put(project.project, 'packs/gameplay/api/init.ts', 'import \'./view\';');
  await put(project.project, 'packs/gameplay/api/view.tsx', 'export const view = <label />;');

  const built = await runBuild({ configPath: project.configPath, logger: {} });
  const metadata = JSON.parse(await readFile(path.join(built.apiOutput, 'package.json'), 'utf8'));
  const declarations = await readFile(path.join(built.apiOutput, metadata.exports['.'].types), 'utf8');

  assert.match(declarations, /read\(input: string\): Promise<string>/);
  await put(project.project, 'ui.tsconfig.json', { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'missing-ui' } });
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /missing-ui\/jsx-runtime/);
});

test('published implementation objects project writable source types while preserving authored interfaces', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/api/index.ts', `
    export interface Balance {gold:number}
    interface Observable<T> {get():T;set(value:T):void;subscribe(listener:(next:T,prev:T)=>void):()=>void}
    interface Signal<T> {emit(value:T):void;subscribe(listener:(value:T)=>void):()=>void}
    export const API = { balance:null! as Observable<Balance>, changed:null! as Signal<Balance> };
  `);
  const built = await runBuild({ configPath: project.configPath, logger: {} });
  const metadata = JSON.parse(await readFile(path.join(built.apiOutput, 'package.json'), 'utf8'));
  const view = await readFile(path.join(built.apiOutput, metadata.exports['.'].types), 'utf8');
  const authored = await readFile(path.join(built.apiOutput, 'types/packs/gameplay/api/index.d.ts'), 'utf8');

  assert.match(view, /ApiModule<typeof Authored\["API"\]>/);
  assert.match(view, /export type \* from/);
  assert.match(authored, /export interface Balance/);
  assert.match(authored, /set\(value: T\): void/);
});

test('Builder consumes published clients and resolves their native dependency without provider source', async (t) => {
  const owner = await fixture(t);
  const published = await runBuild({ configPath: owner.configPath, logger: {} });
  const project = await consumer(t, published.apiOutput);

  project.behavior.dependencies.push({ module_name: 'portable-addon' });
  await put(project.project, 'packs/gameplay/manifest.json', project.behavior);
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import {read} from \'portable-addon\'; import {twice} from \'portable-addon/math\'; export {read,twice};');
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const manifest = JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'manifest.json'), 'utf8'));
  const code = await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  assert.ok(manifest.dependencies.some(dependency => dependency.uuid === owner.behavior.header.uuid && dependency.version === owner.behavior.header.version));
  assert.doesNotMatch(code, /PRIVATE_PROVIDER_BODY|PRIVATE_PROVIDER_INITIALIZATION/);
  assert.match(code, /LIVE_API_CLIENT_LOADED/);
  assert.equal(result.apiOutput, undefined);
});

test('build-time imports select inert clients without loading the live engine client', async (t) => {
  const owner = await fixture(t);
  const published = await runBuild({ configPath: owner.configPath, logger: {} });
  const project = await consumer(t, published.apiOutput);
  const entry = await put(project.project, 'data.ts', 'import {info,read} from \'portable-addon\'; export const revision = info.revision; export {read};');
  const output = path.join(project.project, 'data.mjs');

  await bundleScripts({ root: project.project, entry, outfile: output, platform: 'node', moduleNames: ['portable-addon'] });
  const value = await import(pathToFileURL(output).href);

  assert.equal(value.revision, 1);
  await assert.rejects(value.read('x'), /unavailable during build/);
  assert.doesNotMatch(await readFile(output, 'utf8'), /LIVE_API_CLIENT_LOADED|PRIVATE_PROVIDER/);
});

test('linked published packages resolve identity and clients from their physical package root', async (t) => {
  const owner = await fixture(t);
  const published = await runBuild({ configPath: owner.configPath, logger: {} });
  const client = await consumer(t, published.apiOutput, true);
  const entry = await put(client.project, 'entry.ts', 'export {read} from \'portable-addon\';');
  const result = await bundleScripts({ root: client.project, entry, outfile: 'out.js', moduleNames: ['portable-addon'] });

  assert.ok(result.inputs.some(file => file.startsWith(published.apiOutput)));
  assert.ok(result.inputs.every(file => !file.startsWith(path.join(owner.project, 'packs'))));
});

test('published subpaths retain pack ownership and reject escaping identity paths', async (t) => {
  const owner = await fixture(t);
  const published = await runBuild({ configPath: owner.configPath, logger: {} });
  const project = await consumer(t, published.apiOutput);
  const installed = path.join(project.project, 'node_modules/portable-addon');
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  const secondary = structuredClone(owner.behavior);

  secondary.namespace = 'second_api';
  secondary.header.uuid = '547d1a24-ddf2-48eb-8352-a72c827c993e';
  await put(installed, 'identity/secondary.json', secondary);
  metadata.bedrockCore.api.manifests['./math'] = './identity/secondary.json';
  await put(installed, 'package.json', metadata);
  const entry = await put(project.project, 'entry.ts', 'export {twice} from \'portable-addon/math\';');
  const options = { root: project.project, entry, outfile: 'out.js', moduleNames: ['portable-addon'] };

  await assert.rejects(bundleScripts(options), /another script pack/);
  metadata.bedrockCore.api.manifests['.'] = './../outside.json';
  await put(installed, 'package.json', metadata);
  await assert.rejects(bundleScripts(options), /must stay inside/);
});

test('failed builds preserve the prior API and pack outputs and reject overlapping destinations', async (t) => {
  const project = await fixture(t);
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const before = await readFile(path.join(first.apiOutput, 'package.json'), 'utf8');
  const script = await readFile(path.join(first.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  await put(project.project, 'fail.mjs', 'export function run() { throw new Error(\'EXPORT_BLOCKED\'); }');
  project.config.bedrockCore.plugins = { fail: { module: './fail.mjs' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'fail', before: 'export' }];
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /EXPORT_BLOCKED/);
  assert.equal(await readFile(path.join(first.apiOutput, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(first.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), script);
  project.config.bedrockCore.profiles.default.api = './dist/gameplay';
  await project.save();
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /separate directories/);
});

test('cancellation after API replacement rolls back the package and every native pack', async (t) => {
  const project = await fixture(t);
  const first = await runBuild({ configPath: project.configPath, logger: {} });
  const api = path.join(first.apiOutput, 'entries/index.js');
  const script = path.join(first.outputPaths.gameplay, 'scripts/main.js');
  const previousApi = await readFile(api, 'utf8');
  const previousScript = await readFile(script, 'utf8');
  let replaced = false;

  await put(project.project, 'packs/gameplay/api/index.ts', 'export async function read(input:string):Promise<string>{return input;} export const info={revision:2} as const;');
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {},
    throwIfAborted() {
      if (readFileSync(api, 'utf8') !== previousApi) {
        replaced = true;
        throw new Error('CANCEL_DURING_PUBLICATION');
      }
    },
  };

  await assert.rejects(runBuild({ configPath: project.configPath, signal, logger: {} }), /CANCEL_DURING_PUBLICATION/);
  assert.equal(replaced, true);
  assert.equal(await readFile(api, 'utf8'), previousApi);
  assert.equal(await readFile(script, 'utf8'), previousScript);
});

test('JavaScript providers preserve declared types and ambient declarations in the published package', async (t) => {
  const project = await fixture(t);
  const metadata = JSON.parse(await readFile(path.join(project.project, 'package.json'), 'utf8'));

  metadata.exports['.'] = { types: './packs/gameplay/api/index.d.ts', import: './packs/gameplay/api/index.js' };
  await put(project.project, 'package.json', metadata);
  await rm(path.join(project.project, 'packs/gameplay/api/index.ts'));
  await put(project.project, 'packs/gameplay/api/index.js', 'export async function read(value) { return value.id.length; }');
  await put(project.project, 'packs/gameplay/api/index.d.ts', 'import \'./ambient\'; export declare function read(value: PortableToken): Promise<number>;');
  await put(project.project, 'packs/gameplay/api/ambient.d.ts', 'declare global { interface PortableToken { id: string } } export {};');
  const published = await runBuild({ configPath: project.configPath, logger: {} });
  const client = await consumer(t, published.apiOutput);
  const entry = await put(client.project, 'check.ts', 'import {read} from \'portable-addon\'; const result:Promise<number> = read({id:\'a\'}); void result;\n// @ts-expect-error the published contract requires a string ID\nread({id:2});');
  const program = ts.createProgram([entry], { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => client.project, getNewLine: () => '\n' }));
  await assert.rejects(readFile(path.join(published.outputPaths.gameplay, 'api/index.d.ts')), { code: 'ENOENT' });
});

test('type-only public subpaths publish declarations without executable bindings', async (t) => {
  const project = await fixture(t);
  const metadata = JSON.parse(await readFile(path.join(project.project, 'package.json'), 'utf8'));

  metadata.exports['./contracts'] = { types: './packs/gameplay/api/contracts.d.ts' };
  await put(project.project, 'package.json', metadata);
  await put(project.project, 'packs/gameplay/api/detail.ts', 'export type Identifier = string;');
  await put(project.project, 'packs/gameplay/api/contracts.d.ts', 'import type {Identifier} from \'./detail.ts\'; export interface Request { id: Identifier }');
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const published = JSON.parse(await readFile(path.join(result.apiOutput, 'package.json'), 'utf8'));

  assert.deepEqual(published.exports['./contracts'], { types: './types/packs/gameplay/api/contracts.d.ts' });
  assert.match(await readFile(path.join(result.apiOutput, published.exports['./contracts'].types), 'utf8'), /from ['"]\.\/detail\.js['"]/);
  const client = await consumer(t, result.apiOutput);
  const entry = await put(client.project, 'check.ts', 'import type {Request} from \'portable-addon/contracts\'; const value:Request={id:\'x\'}; void value;');
  const program = ts.createProgram([entry], { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });

  assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
});

test('watch ignores package publication and rebuilds the API for authored contract changes', { timeout: 20000 }, async (t) => {
  const project = await fixture(t, { cleanup: false });
  const cancellation = new AbortController();
  const results = [];
  const errors = [];

  project.config.bedrockCore.profiles.default.watch = { debounceMs: 25 };
  await project.save();
  const watching = watchBuild({ configPath: project.configPath, signal: cancellation.signal, logger: {}, onBuild(result) {
    results.push(result);
  }, onError(error) {
    errors.push(error);
  } });

  t.after(async () => {
    cancellation.abort();
    await watching;
    await project.dispose();
  });

  const until = async (count) => {
    const deadline = Date.now() + 12000;

    while (results.length < count && !errors.length && Date.now() < deadline) {
      await delay(25);
    }

    assert.equal(errors.length, 0, String(errors[0]));
    assert.equal(results.length, count);
  };

  await until(1);
  await put(project.project, 'packs/gameplay/api/index.ts', 'export async function read(value: number):Promise<number>{return value;}');
  await until(2);
  await delay(250);
  assert.equal(results.length, 2);
  assert.equal(errors.length, 0);
});
