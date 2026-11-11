import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { projectFor, put } from '../test-support/project.js';
import { installFakeRuntime } from '../test-support/server-runtime.js';
import { emitApiLibrary } from '../packages/bundler/src/api-library.ts';

async function fixture(t) {
  const { project: root } = await projectFor(t);

  await put(root, 'package.json', JSON.stringify({ name: '@fixture/navigation', type: 'module' }));
  await installFakeRuntime(root, { entry: 'index.ts', source: `
    export interface Installation<T> { readonly value:T; readonly stop?:()=>void }
    export interface InstallationLifetime { defer(stop:()=>void):void }
    export interface Runtime { api:{provideModule(module:string, shape:object, api:object):()=>void} }
    export interface Declaration<T> { install(core:Runtime, lifetime:InstallationLifetime):Installation<T> }
    interface ApiDeclaration<T extends object> extends Declaration<T> { readonly api:T }
    export type ModuleDeclaration<T extends object> = ApiDeclaration<T>;
    const definitions = new WeakMap<object, {module:string; shape:object}>();
    export function defineApiDeclaration<T extends object>(module:string, shape:object, declaration:ModuleDeclaration<T>):ModuleDeclaration<T> {
      definitions.set(declaration.api, {module, shape}); return declaration;
    }
    export function registerModule<T extends object>(api:T):ModuleDeclaration<T> {
      return {api, install(core, lifetime) {
        const definition = definitions.get(api);
        if (!definition) throw new Error('missing generated contract');
        lifetime.defer(core.api.provideModule(definition.module, definition.shape, api));
        return {value:api};
      }};
    }
    export function contract(api:object):unknown { return definitions.get(api); }
  ` });
  const entry = await put(root, 'src/api.ts', `
    import {registerModule, type ModuleDeclaration} from '@bedrock-core/server-runtime';
    export interface Tree { label:string; children:Tree[] }
    export function create(value:number):ModuleDeclaration<{open(tree:Tree):Promise<number>}> {
      const API = {async open(tree:Tree):Promise<number> { return value + tree.children.length; }};
      return registerModule(API);
    }
  `);
  const generate = () => emitApiLibrary({ root, entry: 'src/api.ts', output: 'src/api.generated.ts' });

  return { root, entry, generate };
}

test('checked library factories run with plain esbuild and retain separate implementation instances', async (t) => {
  const { root, generate } = await fixture(t);
  const result = await generate();
  const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
  const output = await readFile(result.output, 'utf8');

  assert.equal(receipt.package, '@fixture/navigation');
  assert.equal(receipt.sha256, createHash('sha256').update(output).digest('hex'));
  assert.ok(receipt.inputs.some(input => input.file === 'src/api.ts'));
  const entry = await put(root, 'main.ts', `
    import {create} from './src/api.generated';
    import {contract} from '@bedrock-core/server-runtime';
    const a = create(2); const b = create(7);
    export const published:object[] = []; export const retired:object[] = [];
    const releases:(()=>void)[] = [];
    const core = {api:{provideModule(_module:string, _shape:object, api:object) {
      published.push(api); return () => {retired.push(api);};
    }}};
    const lifetime = {defer(stop:()=>void) { releases.push(stop); }};
    export const first = a.install(core, lifetime).value; export const second = b.install(core, lifetime).value;
    export const definition = contract(first); export const otherDefinition = contract(second);
    export function stop() { for (const release of releases.splice(0).reverse()) release(); }
  `);
  const outfile = path.join(root, 'main.mjs');

  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const bundled = await import(pathToFileURL(outfile).href);

  assert.notEqual(bundled.first, bundled.second);
  assert.equal(await bundled.first.open({ label: 'root', children: [] }), 2);
  assert.equal(await bundled.second.open({ label: 'root', children: [] }), 7);
  assert.equal(bundled.definition.module, bundled.otherDefinition.module);
  assert.match(bundled.definition.module, /^@fixture\/navigation\/api#create:[a-f0-9]+$/);
  assert.deepEqual(bundled.definition.shape, { kind: 'object', members: { open: { kind: 'function' } } });
  assert.deepEqual(bundled.published, [bundled.first, bundled.second]);
  assert.deepEqual(bundled.retired, []);
  bundled.stop();
  assert.deepEqual(bundled.retired, [bundled.second, bundled.first]);
});

test('library fingerprints change with public types and reject recursive executable payloads before writing', async (t) => {
  const { entry, generate } = await fixture(t);
  const first = await generate();
  const original = await readFile(entry, 'utf8');
  const firstOutput = await readFile(first.output, 'utf8');

  await writeFile(entry, original.replace('label:string', 'label:number'));
  const second = await generate();
  const secondOutput = await readFile(second.output, 'utf8');

  assert.notEqual(secondOutput, firstOutput);
  await writeFile(entry, original.replace('label:string', 'label:string; invoke():Promise<void>'));
  await assert.rejects(generate, /recursive transport types|constant arrays must be readonly/);
  assert.equal(await readFile(second.output, 'utf8'), secondOutput);
});

test('library generation refuses to overwrite source or emit a non-TypeScript wrapper', async (t) => {
  const { root } = await fixture(t);

  for (const output of ['src/api.ts', '../outside.ts', 'src/api.json']) {
    await assert.rejects(emitApiLibrary({ root, entry: 'src/api.ts', output }), /separate file inside its package/);
  }
});
