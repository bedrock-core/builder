import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectFor, put } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { installFakeRuntime } from '../test-support/server-runtime.js';
import { bundleScripts } from '../packages/bundler/src/index.ts';
import { inspectApiModule, apiExports } from '../packages/bundler/src/api.ts';
import { bundleUiDeclaration, bundleUiModule } from '../packages/ui-compiler/src/bundle.ts';
import { readUiDeclaration } from '../packages/ui-compiler/src/declaration.ts';
import { runBuild } from '../src/run.ts';
import { run as runBundler } from '../packages/bundler/src/plugin.ts';

const runtime = `
const definitions = new WeakMap();
export const core = { api:{provideModule:provideApiModule}, register(options) {
  const lifetime = {defer() {}};
  for (const value of Object.values(options)) value?.install?.(core, lifetime);
} };
export function defineApiModule(moduleName, shape, exports) {
  for (const value of [exports, ...Object.values(exports)]) {
    if (value && typeof value === 'object') {
      const modules = definitions.get(value) ?? [];
      modules.push({moduleName, shape, exports}); definitions.set(value, modules);
    }
  }
}
export function registerModule(api) {
  return {api, install(core, lifetime) {
    const modules = definitions.get(api);
    if (!modules) throw new Error('API metadata missing');
    for (const entry of modules) lifetime.defer(core.api.provideModule(entry.moduleName, entry.shape, entry.exports));
    return {value:api};
  }};
}
export function createApiModule(namespace, moduleName, shape) {
  const node = shape => {
    if (shape.kind === 'local') return shape.value;
    if (shape.kind === 'value') return typeof shape.value === 'object' && shape.value !== null ? Object.freeze(shape.value) : shape.value;
    if (shape.kind === 'function') return async () => { throw new Error('Addon API unavailable during evaluation'); };
    if (shape.kind === 'state') return Object.freeze({ get: () => undefined, subscribe: () => () => {} });
    if (shape.kind === 'event') return Object.freeze({ subscribe: () => () => {} });
    return Object.freeze(Object.fromEntries(Object.entries(shape.members).map(([key, value]) => [key, node(value)])));
  };
  return node(shape);
}

export function provideApiModule(moduleName, shape, exports) {
  (globalThis.apiModules ??= []).push({ moduleName, shape, exports, setup: globalThis.entrySetup });
  return () => {};
}
`;
const types = `
export interface ReadonlyObservable<T> { get(): T; subscribe(listener: (next:T, prev:T) => void): () => void }
export interface Signal<T> { subscribe(listener: (payload:T) => void): () => void }
`;
const api = `
${types}
export async function balance(id:string, actor?:string):Promise<number> { return id.length + (actor?.length ?? 0); }
export async function fail():Promise<never> { throw new Error('remote failure'); }
export const currency:ReadonlyObservable<string | undefined> = null!;
export const changed:Signal<{ playerId:string; gold:number }> = null!;
export const info = { currency:'gold', symbols:['G', 'g'], nested:{ digits:2, zeta:true, alpha:false } } as const;
export const tools = { async add(a:number,b:number):Promise<number> { return a+b; } };
`;

async function fixture(t) {
  const project = await projectFor(t);
  const provider = { ...manifestFor('script'), namespace: 'public_provider' };
  const marker = path.join(project.root, 'provider-started');
  const poison = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); throw new Error('PROVIDER_STARTED');\n`;

  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'node_modules/public-addon/package.json', JSON.stringify({
    name: 'public-addon', version: '1.0.0', type: 'module', exports: { '.': './api.ts', './math': './math.ts', './manifest.json': './manifest.json' },
  }));
  await put(project.project, 'node_modules/public-addon/manifest.json', JSON.stringify(provider));
  const source = await put(project.project, 'node_modules/public-addon/api.ts', poison + api);

  await put(project.project, 'node_modules/public-addon/math.ts', poison + 'export async function multiply(a:number,b:number):Promise<number> { return a*b; }');
  await installFakeRuntime(project.project, { source: runtime });
  project.config.bedrockCore.profiles.default.stages = { 'manifest': true, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false, 'bundler': { debug: true } };

  async function save() {
    await put(project.project, 'packs/gameplay/manifest.json', JSON.stringify(project.behavior));
    await put(project.project, 'config.json', JSON.stringify(project.config));
  }

  await save();

  return { ...project, source, provider, marker, poison, save };
}

const valueClass = `
export class Money {
  static readonly codec = {
    encode(value:Money):number { return value.gold; },
    decode(gold:number):Money { return new Money(gold); }
  };
  constructor(readonly gold:number) {}
  format():string { return this.gold + ' gold'; }
}
`;

async function valueFixture(t) {
  const project = await fixture(t);
  const metadataFile = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));

  metadata.exports['./values'] = './values.ts';
  await writeFile(metadataFile, JSON.stringify(metadata));
  await put(project.project, 'node_modules/public-addon/values.ts', valueClass);
  await writeFile(project.source, project.poison + `
    import {Money} from './values'; export {Money};
    ${types}
    export async function quote(value:{prices:Money[]; pair:[Money,string]; byId:Record<string,Money>}, confirm:(price:Money,note?:string,...rest:Money[])=>Promise<Money>):Promise<Money> { return confirm(value.prices[0]); }
    export const balance:ReadonlyObservable<Money|undefined> = null!;
    export const changed:Signal<{price:Money}> = null!;
  `);

  return project;
}

test('value classes and callbacks generate typed transforms and inert shared constructor imports', async (t) => {
  const project = await valueFixture(t);
  const inspected = await inspectApiModule(project.project, 'public-addon');
  const shape = inspected.shape.members;

  assert.equal(shape.Money.kind, 'local');
  assert.equal(shape.quote.parameters.items[0].members.prices.item.kind, 'codec');
  assert.equal(shape.quote.parameters.items[0].members.byId.index.kind, 'codec');
  assert.equal(shape.quote.parameters.items[1].kind, 'callback');
  assert.equal(shape.quote.parameters.items[1].parameters.rest.kind, 'codec');
  assert.equal(shape.balance.data.kind, 'codec');
  assert.equal(shape.changed.data.members.price.kind, 'codec');
  const source = await put(project.project, 'values-consumer.ts', `import { Money } from 'public-addon'; import { Money as Shared } from 'public-addon/values'; export const result = new Money(7).format(); export const same = Money === Shared; export default result;`);
  const bundle = await bundleScripts({ root: project.project, entry: 'values-consumer.ts', outfile: 'values-consumer.mjs', moduleNames: ['public-addon'] });
  const code = await readFile(bundle.files[0], 'utf8');
  const imported = await import(pathToFileURL(bundle.files[0]).href);

  assert.equal(imported.result, '7 gold');
  assert.equal(imported.same, true);
  assert.doesNotMatch(code, /PROVIDER_STARTED|writeFileSync/);
  const ui = await bundleUiModule({ root: project.project, dependencyRoot: project.project, source, exports: {}, moduleNames: ['public-addon'] });
  const uiFile = await put(project.project, 'values-ui.mjs', ui.code);
  const evaluated = await import(pathToFileURL(uiFile).href);

  assert.equal(evaluated.default, '7 gold');
  assert.equal(evaluated.same, true);
  assert(ui.inputs.includes(path.join(project.project, 'node_modules/public-addon/values.ts')));
  assert(ui.inputs.every(file => !file.includes('core-api-value:')));
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('published class declarations select their shared executable codec module', async (t) => {
  const project = await valueFixture(t);
  const metadataFile = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));

  metadata.exports['.'] = { types: './api.d.ts', import: './api.ts' };
  metadata.exports['./values'] = { types: './values.d.ts', import: './values.js' };
  await writeFile(metadataFile, JSON.stringify(metadata));
  await rm(path.join(project.project, 'node_modules/public-addon/values.ts'));
  await put(project.project, 'node_modules/public-addon/values.d.ts', `export declare class Money { static readonly codec:{encode(value:Money):number;decode(value:number):Money}; readonly gold:number; constructor(gold:number); format():string; }`);
  await put(project.project, 'node_modules/public-addon/values.js', `export class Money { static codec={encode:value=>value.gold,decode:gold=>new Money(gold)}; constructor(gold){this.gold=gold;} format(){return this.gold+' gold';} }`);
  await put(project.project, 'node_modules/public-addon/api.d.ts', `import {Money} from './values'; export {Money}; export declare function quote(confirm:(value:Money)=>Promise<boolean>):Promise<Money>;`);
  const inspected = await inspectApiModule(project.project, 'public-addon');

  assert.match(inspected.shape.members.Money.value.source, /values\.js$/);
  assert.equal(inspected.shape.members.quote.parameters.items[0].kind, 'callback');
});

test('implementation objects accept writable sources and nested shared constructors without exposing writes', async (t) => {
  const project = await valueFixture(t);

  await writeFile(project.source, project.poison + `
    import {Money} from './values'; export {Money};
    ${types}
    interface Observable<T> extends ReadonlyObservable<T> { set(value:T):void }
    export const API = {
      Money,
      currency: null! as Observable<string>,
      changed: null! as Signal<Money> & {emit(value:Money):void},
      async quote(price:Money):Promise<Money> { return price; },
    };
  `);
  const inspected = await inspectApiModule(project.project, 'public-addon');

  assert.equal(inspected.consumerView, true);
  assert.equal(inspected.shape.members.API.members.Money.kind, 'local');
  assert.equal(inspected.shape.members.API.members.currency.kind, 'state');
  assert.equal(inspected.shape.members.API.members.changed.kind, 'event');
  const entry = await put(project.project, 'object-client.ts', `import {API} from 'public-addon'; export const value = new API.Money(3).format(); export const writable = 'set' in API.currency || 'emit' in API.changed;`);
  const built = await bundleScripts({ root: project.project, entry, outfile: 'object-client.mjs', moduleNames: ['public-addon'] });
  const client = await import(pathToFileURL(built.files[0]).href);

  assert.equal(client.value, '3 gold');
  assert.equal(client.writable, false);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('nested world APIs describe official entity references alongside class and callback codecs', async (t) => {
  const project = await valueFixture(t);

  await put(project.project, 'node_modules/@minecraft/server/package.json', JSON.stringify({ name: '@minecraft/server', types: './index.d.ts', exports: { '.': { types: './index.d.ts', import: './index.js' } } }));
  await put(project.project, 'node_modules/@minecraft/server/index.js', 'export {};');
  await put(project.project, 'node_modules/@minecraft/server/index.d.ts', 'export declare class Entity { readonly id:string; readonly isValid:boolean; addTag(tag:string):boolean; } export declare class Player extends Entity { nameTag:string; }');
  await writeFile(project.source, project.poison + `
    import type {Entity,Player} from '@minecraft/server'; import {Money} from './values'; export {Money};
    ${types}
    export interface WorldApi {
      readonly afterEvents:{readonly dropped:Signal<{entity:Entity|undefined;price:Money}>};
      readonly selected:ReadonlyObservable<Player|undefined>;
      quote(entity:Entity,price:Money,confirm:(player:Player,price:Money)=>Promise<Entity|undefined>):Promise<Player|null>;
    }
    export const world:WorldApi = null!;
  `);
  const inspected = await inspectApiModule(project.project, 'public-addon');
  const world = inspected.shape.members.world.members;

  assert.deepEqual(world.afterEvents.members.dropped.data.members.entity, { kind: 'reference', reference: 'entity', missing: 'undefined' });
  assert.deepEqual(world.selected.data, { kind: 'reference', reference: 'player', missing: 'undefined' });
  assert.deepEqual(world.quote.parameters.items[0], { kind: 'reference', reference: 'entity' });
  assert.equal(world.quote.parameters.items[1].kind, 'codec');
  assert.deepEqual(world.quote.parameters.items[2].parameters.items[0], { kind: 'reference', reference: 'player' });
  assert.deepEqual(world.quote.parameters.items[2].result, { kind: 'reference', reference: 'entity', missing: 'undefined' });
  assert.deepEqual(world.quote.result, { kind: 'reference', reference: 'player', missing: 'null' });
  await put(project.project, 'world-consumer.ts', `import {world} from 'public-addon'; export default world;`);
  const bundled = await bundleScripts({ root: project.project, entry: 'world-consumer.ts', outfile: 'world-client.mjs', moduleNames: ['public-addon'] });
  const client = await import(pathToFileURL(bundled.files[0]).href);

  assert.equal(client.default.selected.get(), undefined);
  assert.equal(typeof client.default.afterEvents.dropped.subscribe, 'function');
  await assert.rejects(client.default.quote(), /unavailable during evaluation/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
  await writeFile(project.source, 'class Entity {id="ordinary-class"} export async function read():Promise<Entity> {return new Entity()}');
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /value classes need a static readonly codec/);
});

test('native component, inventory and value signatures select explicit SDK transport contracts', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'node_modules/@minecraft/server/package.json', JSON.stringify({ name: '@minecraft/server', types: './index.d.ts' }));
  await put(project.project, 'node_modules/@minecraft/server/index.d.ts', `
    export declare class Entity { readonly id:string }
    export declare class EntityComponent { readonly entity:Entity; readonly typeId:string }
    export declare class EntityInventoryComponent extends EntityComponent { readonly container:Container }
    export declare class Container { getSlot(index:number):ContainerSlot }
    export declare class ContainerSlot { readonly isValid:boolean }
    export declare class ItemStack { readonly amount:number }
    export declare class BlockPermutation { getAllStates():Record<string,string|number|boolean> }
    export declare class ScoreboardObjective { readonly id:string }
  `);
  await writeFile(project.source, `import type {EntityInventoryComponent,Container,ContainerSlot,ItemStack,BlockPermutation} from '@minecraft/server';
    export async function component():Promise<EntityInventoryComponent|undefined>{return undefined}
    export async function container():Promise<Container>{throw new Error()}
    export async function slot(value:ContainerSlot):Promise<ContainerSlot>{return value}
    export async function values(item:ItemStack,block:BlockPermutation):Promise<{item:ItemStack;block:BlockPermutation}>{return {item,block}}
  `);
  const inspected = await inspectApiModule(project.project, 'public-addon');
  const members = inspected.shape.members;

  assert.deepEqual(members.component.result, { kind: 'reference', reference: 'entity-component', nativeType: 'EntityInventoryComponent', missing: 'undefined' });
  assert.deepEqual(members.container.result, { kind: 'reference', reference: 'container', nativeType: 'Container' });
  assert.deepEqual(members.slot.result, { kind: 'reference', reference: 'container-slot', nativeType: 'ContainerSlot' });
  assert.deepEqual(members.values.parameters.items, [{ kind: 'native-value', value: 'item-stack' }, { kind: 'native-value', value: 'block-permutation' }]);
  assert.deepEqual(members.values.result.members.item, { kind: 'native-value', value: 'item-stack' });
  await writeFile(project.source, 'import type {ScoreboardObjective} from \'@minecraft/server\'; export async function read():Promise<ScoreboardObjective>{throw new Error()}');
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /unsupported Minecraft class ScoreboardObjective/);
});

test('shared library classes rebuild dependent API bundles when their implementation changes', async (t) => {
  const project = await fixture(t);
  const shared = await put(project.project, 'node_modules/value-library/index.ts', valueClass);

  await put(project.project, 'node_modules/value-library/package.json', JSON.stringify({ name: 'value-library', type: 'module', exports: { '.': './index.ts' } }));
  await writeFile(project.source, project.poison + `import {Money} from 'value-library'; export {Money}; export async function double(value:Money):Promise<Money> {return new Money(value.gold*2)}`);
  project.behavior.dependencies.push({ module_name: 'public-addon' });
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import {Money as ApiMoney} from 'public-addon'; import {Money} from 'value-library'; export const same = Money === ApiMoney; console.warn(new Money(3).format());`);
  await project.save();
  const options = { configPath: project.configPath, logger: {} };
  const cold = await runBuild(options);
  const warm = await runBuild(options);

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  assert(cold.dependencies.includes(shared));
  const imported = await import(pathToFileURL(path.join(cold.outputPaths.gameplay, 'scripts/main.js')).href);

  assert.equal(imported.same, true);
  await writeFile(shared, valueClass.replace('\' gold\'', '\' coins\''));
  const changed = await runBuild(options);

  assert.equal(changed.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.match(await readFile(path.join(changed.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), / coins/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('API object contracts remain stable across public entries and declarations', async (t) => {
  const project = await valueFixture(t);
  const contract = `import {Money} from './values'; ${types}
    export interface Account {readonly balance:ReadonlyObservable<Money|undefined>;deposit(value:Money):Promise<Money>;close():Promise<void>}
  `;
  const methods = `export const accounts={async open():Promise<Account>{return null!},async identity(value:Account):Promise<boolean>{return true}};`;

  await writeFile(project.source, project.poison + contract + methods);
  await put(project.project, 'node_modules/public-addon/math.ts', `import type {Account} from './api'; export async function forward(value:Account):Promise<Account>{return value}`);
  const original = await inspectApiModule(project.project, 'public-addon');
  const peer = await inspectApiModule(project.project, 'public-addon/math');
  const account = original.shape.members.accounts.members.open.result;

  assert.equal(account.reference, 'api');
  assert.equal(account.shape.members.balance.kind, 'state');
  assert.equal(original.shape.members.accounts.members.identity.parameters.items[0].contract, account.contract);
  assert.equal(peer.shape.members.forward.parameters.items[0].contract, account.contract);
  assert.equal(peer.shape.members.forward.result.contract, account.contract);
  const metadataFile = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));

  metadata.exports['.'] = { types: './api.d.ts', import: './api.ts' };
  await writeFile(metadataFile, JSON.stringify(metadata));
  await put(project.project, 'node_modules/public-addon/api.d.ts', contract + 'export declare const accounts:{open():Promise<Account>;identity(value:Account):Promise<boolean>};');
  const published = await inspectApiModule(project.project, 'public-addon');

  assert.equal(published.shape.members.accounts.members.open.result.contract, account.contract);
  await writeFile(project.source, 'export interface Recursive {next():Promise<Recursive>} export async function open():Promise<Recursive>{return null!}');
  delete metadata.exports['.'].types;
  metadata.exports['.'] = './api.ts';
  await writeFile(metadataFile, JSON.stringify(metadata));
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /finite, non-recursive/);
});

test('shared class entries reject remote API exports', async (t) => {
  const project = await valueFixture(t);

  await put(project.project, 'node_modules/public-addon/values.ts', valueClass + 'export async function remote():Promise<number> {return 1}');
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /shared value entries must export classes and data/);
});

test('shared value code cannot load Minecraft or the runtime through transitive imports', async (t) => {
  const project = await valueFixture(t);

  await put(project.project, 'values-consumer.ts', `import {Money} from 'public-addon'; export const value = new Money(1);`);

  for (const dependency of ['@minecraft/server', '@bedrock-core/server-runtime']) {
    await put(project.project, 'node_modules/public-addon/local-helper.ts', `import * as native from '${dependency}'; export const helper=native;`);
    await put(project.project, 'node_modules/public-addon/values.ts', `import {helper} from './local-helper'; console.log(helper);\n${valueClass}`);
    await assert.rejects(bundleScripts({ root: project.project, entry: 'values-consumer.ts', outfile: 'values-consumer.mjs', moduleNames: ['public-addon'] }), /Shared API values must be engine-free/);
  }

  await put(project.project, 'node_modules/public-addon/local-helper.ts', `import * as remote from 'public-addon/math'; export const helper=remote;`);
  await assert.rejects(bundleScripts({ root: project.project, entry: 'values-consumer.ts', outfile: 'values-consumer.mjs', moduleNames: ['public-addon'] }), /Shared API values cannot import the remote API public-addon\/math/);
});

test('callback and codec contracts reject ambiguous mappings and accept structured codec data', async (t) => {
  const project = await valueFixture(t);

  for (const [source, diagnostic] of [
    [`import {Money} from './values'; export async function quote(value:Money|number):Promise<Money> {return null!}`, /union alternatives/],
    [`export async function quote(confirm:(value:number)=>boolean):Promise<boolean> {return false}`, /must return Promise/],
    [`export async function quote():Promise<()=>Promise<void>> {return null!}`, /unsupported transport type/],
    [`export async function quote(confirm:(next:()=>Promise<void>)=>Promise<void>):Promise<void> {}`, /unsupported transport type/],
  ]) {
    await writeFile(project.source, source);
    await assert.rejects(inspectApiModule(project.project, 'public-addon'), diagnostic);
  }

  await writeFile(project.source, `import {Money} from './values'; export async function quote():Promise<Money> {return null!}`);
  await put(project.project, 'node_modules/public-addon/values.ts', valueClass.replace('encode(value:Money):number { return value.gold; }', 'encode(value:Money):bigint { return BigInt(value.gold); }').replace('decode(gold:number)', 'decode(gold:bigint)').replace('new Money(gold)', 'new Money(Number(gold))'));
  assert.equal((await inspectApiModule(project.project, 'public-addon')).shape.members.quote.result.kind, 'codec');
});

test('standard collections and structured primitives produce checked public API contracts', async (t) => {
  const project = await valueFixture(t);

  await writeFile(project.source, `${types}
    import {Money} from './values';
    export interface Tree {value:bigint; children:Map<string, Tree>}
    export async function values(input:{map:Map<string, Set<number>>; readonly:ReadonlyMap<string, ReadonlySet<number>>; date:Date; pattern:RegExp; bytes:Uint8Array; view:DataView; buffer:ArrayBuffer; exact:bigint; tree:Tree}):Promise<typeof input>{return input}
    export async function adapt(input:Map<string,Set<Money>>):Promise<Map<string,Set<Money>>>{return input}
    export const current:ReadonlyObservable<Map<string,Set<Money>>> = null!;
    export const changed:Signal<Set<Money>> = null!;
  `);
  const inspected = await inspectApiModule(project.project, 'public-addon');

  assert.deepEqual(inspected.shape.members.values, { kind: 'function' });
  assert.equal(inspected.shape.members.adapt.parameters.items[0].kind, 'map');
  assert.equal(inspected.shape.members.adapt.parameters.items[0].value.item.kind, 'codec');
  assert.equal(inspected.shape.members.current.data.value.item.kind, 'codec');
  assert.equal(inspected.shape.members.changed.data.item.kind, 'codec');
  await put(project.project, 'collections.ts', `import {adapt, current, changed} from 'public-addon'; export {adapt, current, changed};`);
  const bundle = await bundleScripts({ root: project.project, entry: 'collections.ts', outfile: 'collections.mjs', moduleNames: ['public-addon'] });

  assert.doesNotMatch(await readFile(bundle.files[0], 'utf8'), /PROVIDER_STARTED/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('collection keys and values must have concrete supported transport types', async (t) => {
  const project = await fixture(t);

  for (const value of ['Map<string,unknown>', 'Set<symbol>', 'WeakMap<object,number>', 'WeakSet<object>', 'Map<string,()=>void>']) {
    await writeFile(project.source, `export async function inspect(value:${value}):Promise<void>{}`);
    await assert.rejects(inspectApiModule(project.project, 'public-addon'), /unsupported transport type|must return Promise/);
  }
});
test('normal named, namespace, subpath and manifest imports generate inert clients without provider code', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'entry.ts', `
    import { balance, currency, changed, info, tools } from 'public-addon';
    import * as math from 'public-addon/math';
    import metadata, { namespace } from 'public-addon/manifest.json';
    export { balance, currency, changed, info, tools, math, metadata, namespace };
  `);
  const result = await bundleScripts({ root: project.project, entry: 'entry.ts', outfile: 'client.mjs', moduleNames: ['public-addon'], debug: true });
  const output = result.files.find(file => file.endsWith('.mjs'));
  const code = await readFile(output, 'utf8');
  const client = await import(pathToFileURL(output).href);

  assert.equal(client.info.currency, 'gold');
  assert.equal(client.info.nested.digits, 2);
  assert.deepEqual(client.info.symbols, ['G', 'g']);
  assert.deepEqual(Object.keys(client.info), ['currency', 'symbols', 'nested']);
  assert.deepEqual(Object.keys(client.info.nested), ['digits', 'zeta', 'alpha']);
  assert.equal(client.currency.get(), undefined);
  assert.equal(client.currency.set, undefined);
  assert.equal(client.changed.emit, undefined);
  assert.equal(client.namespace, 'public_provider');
  assert.equal(client.metadata.header.uuid, project.provider.header.uuid);
  await assert.rejects(client.math.multiply(2, 3), /unavailable during evaluation/);
  assert.doesNotMatch(code, /PROVIDER_STARTED|writeFileSync|id\.length|return a\s*\*\s*b/);
  assert.equal(result.cacheable, true);
  assert(result.watchFiles.includes(project.source));
  assert(result.watchFiles.includes(path.join(project.project, 'node_modules/public-addon/package.json')));
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('API imports keep precedence over aliases, explicit externals and custom resolver plugins', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'entry.ts', 'export { info } from "public-addon";');
  await put(project.project, 'wrong.ts', 'throw new Error("ALIAS_EXECUTED"); export const info = null;');
  const result = await bundleScripts({
    root: project.project, entry: 'entry.ts', outfile: 'precedence.mjs', moduleNames: ['public-addon'],
    external: ['public-addon'], aliases: { 'public-addon': 'wrong.ts' }, plugins: [{ name: 'wrong-resolver', setup(build) {
      build.onResolve({ filter: /^public-addon$/ }, () => {
        throw new Error('CUSTOM_RESOLVER_EXECUTED');
      });
    } }],
  });

  assert.equal((await import(pathToFileURL(result.files[0]).href)).info.currency, 'gold');
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('script-only API clients share project Runtime and UI registries with nested file dependencies', async (t) => {
  const project = await fixture(t);
  const library = 'node_modules/file-snapshot';

  async function installSingletons(base, id) {
    await put(base, 'node_modules/@bedrock-core/server-runtime/package.json', '{"name":"@bedrock-core/server-runtime","type":"module","exports":{".":"./index.js","./api":"./api.js"}}');
    await put(base, 'node_modules/@bedrock-core/server-runtime/index.js', `export const core = { id:${JSON.stringify(id)}, registered:false, register() { this.registered=true; } };`);
    await put(base, 'node_modules/@bedrock-core/server-runtime/api.js', `
      import { core } from './index.js';
      export function createApiModule(namespace,moduleName,shape) {
        const bind = shape => shape.kind === 'function'
          ? async () => { if (!core.registered) throw new Error('CLIENT_RUNTIME_NOT_REGISTERED'); return core.id; }
          : shape.kind === 'value' ? shape.value
          : shape.kind === 'state' ? {get:()=>undefined,subscribe:()=>()=>{}}
          : shape.kind === 'event' ? {subscribe:()=>()=>{}}
          : Object.fromEntries(Object.entries(shape.members).map(([key,value])=>[key,bind(value)]));
        return bind(shape);
      }
    `);
    await put(base, 'node_modules/@bedrock-core/server/package.json', '{"name":"@bedrock-core/server","type":"module","exports":"./index.js"}');
    await put(base, 'node_modules/@bedrock-core/server/index.js', 'export { core } from "@bedrock-core/server-runtime";');
    await put(base, 'node_modules/@bedrock-core/ui-runtime/package.json', '{"name":"@bedrock-core/ui-runtime","type":"module","exports":"./index.js"}');
    await put(base, 'node_modules/@bedrock-core/ui-runtime/index.js', 'const screens = new Map(); export const registerScreen=(key,value)=>screens.set(key,value); export const screenForKey=key=>screens.get(key);');
    await put(base, 'node_modules/@bedrock-core/server-runtime-extra/package.json', '{"name":"@bedrock-core/server-runtime-extra","type":"module","exports":"./index.js"}');
    await put(base, 'node_modules/@bedrock-core/server-runtime-extra/index.js', `export const marker=${JSON.stringify(id)};`);
  }

  await installSingletons(project.project, 'project-runtime');
  await installSingletons(path.join(project.project, library), 'nested-runtime');
  await put(project.project, `${library}/package.json`, '{"name":"file-snapshot","type":"module","exports":"./index.js"}');
  await put(project.project, `${library}/index.js`, `
    import { core } from '@bedrock-core/server-runtime';
    import { core as facade } from '@bedrock-core/server';
    import { screenForKey } from '@bedrock-core/ui-runtime';
    export { marker } from '@bedrock-core/server-runtime-extra';
    export function setup() { if (core !== facade) throw new Error('DUPLICATE_RUNTIME'); core.register(); }
    export const snapshot = () => screenForKey('screen');
  `);
  await put(project.project, 'packs/gameplay/scripts/main.ts', `
    import { core } from '@bedrock-core/server';
    import { balance } from 'public-addon';
    import { registerScreen } from '@bedrock-core/ui-runtime';
    import { setup, snapshot, marker } from 'file-snapshot';
    registerScreen('screen', 'project-screen'); setup();
    export async function inspect() { return { id:core.id, bound:await balance('one'), screen:snapshot(), ordinary:marker }; }
  `);
  project.behavior.dependencies.push({ module_name: 'public-addon' });
  await project.save();
  const build = await runBuild({ configPath: project.configPath, logger: {} });
  const code = await readFile(path.join(build.outputPaths.gameplay, 'scripts/main.js'), 'utf8');
  const executable = await put(project.project, 'singleton.mjs', code);
  const result = await import(pathToFileURL(executable).href);

  assert.deepEqual(await result.inspect(), { id: 'project-runtime', bound: 'project-runtime', screen: 'project-screen', ordinary: 'nested-runtime' });
  assert.doesNotMatch(code, /PROVIDER_STARTED|writeFileSync/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });

  const alias = await put(project.project, 'custom-runtime.js', 'export const core = { id:"authored-alias" };');

  await put(project.project, 'alias.ts', 'export { core } from "@bedrock-core/server-runtime";');
  const aliased = await bundleScripts({ root: project.project, entry: 'alias.ts', outfile: 'alias.mjs', aliases: { '@bedrock-core/server-runtime': alias } });

  assert.equal((await import(pathToFileURL(aliased.files[0]).href)).core.id, 'authored-alias');
});

test('checked async signatures emit only export kinds and constants', async (t) => {
  const project = await fixture(t);
  const original = await inspectApiModule(project.project, 'public-addon');

  assert.equal(original.shape.members.fail.kind, 'function');
  assert.deepEqual(original.shape.members.fail, { kind: 'function' });
  assert.equal(original.shape.members.currency.kind, 'state');
  assert.equal(original.shape.members.changed.kind, 'event');
  await writeFile(project.source, project.poison + api.replace('Promise<number> { return id.length', 'Promise<string> { return String(id.length').replace('(actor?.length ?? 0);', '(actor?.length ?? 0));'));
  const modified = await inspectApiModule(project.project, 'public-addon');

  assert.deepEqual(original.shape, modified.shape);
  assert.doesNotMatch(JSON.stringify(modified.shape), /"contract"|Promise|parameters/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('type-only reexports erase and conditional declaration exports retain public async contracts', async (t) => {
  const project = await fixture(t);
  const metadataPath = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  await put(project.project, 'node_modules/public-addon/private.d.ts', 'export declare class Unsafe { method():number }');
  await put(project.project, 'node_modules/public-addon/api.d.ts', `
    export type { Unsafe as TypeOnly } from './private';
    export type * from './private';
    export type * as PrivateTypes from './private';
    export interface Payload { amount:number }
    export declare function read():Promise<Payload>;
  `);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, exports: { ...metadata.exports, '.': { types: './api.d.ts', import: './api.ts' } } }));
  const result = await inspectApiModule(project.project, 'public-addon');

  assert.deepEqual(Object.keys(result.shape.members), ['read']);
  assert.deepEqual(result.shape.members.read, { kind: 'function' });
  assert(result.inputs.includes(path.join(project.project, 'node_modules/public-addon/api.d.ts')));
});

test('actual framework ReadonlyObservable and Signal declarations expose readonly subscriptions', async (t) => {
  const project = await fixture(t);
  const observable = fileURLToPath(new URL('../../server/packages/observable/src/index.ts', import.meta.url));

  try {
    await access(observable);
  } catch {
    t.skip('Actual framework source is exercised by addon API acceptance when the sibling Server checkout is unavailable');

    return;
  }

  await writeFile(project.source, `
    import type { ReadonlyObservable, Signal } from ${JSON.stringify(observable)};
    export const value:ReadonlyObservable<string | undefined> = null!;
    export const changed:Signal<{amount:number}> = null!;
    export const explicitEvent:Signal<{amount:number}> = null!;
    export const explicitState:ReadonlyObservable<string | undefined> = null!;
    export const converted:Signal<string> = null!;
    export const optionalCleanup: { subscribe(listener:(payload:string)=>void):(hint?:string)=>void } = null!;
  `);
  const result = await inspectApiModule(project.project, 'public-addon');

  assert.equal(result.shape.members.value.kind, 'state');
  assert.equal(result.shape.members.changed.kind, 'event');
  assert.deepEqual(result.shape.members.explicitEvent, { kind: 'event' });
  assert.deepEqual(result.shape.members.explicitState, { kind: 'state' });
  assert.deepEqual(result.shape.members.converted, { kind: 'event' });
  assert.equal(result.shape.members.optionalCleanup.kind, 'event');
});

test('published readonly literal tuples preserve static immutable constants', async (t) => {
  const project = await fixture(t);
  const metadataPath = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  await put(project.project, 'node_modules/public-addon/api.d.ts', 'export declare const symbols:readonly ["gold", {readonly digits:2}];');
  await writeFile(metadataPath, JSON.stringify({ ...metadata, exports: { ...metadata.exports, '.': { types: './api.d.ts', default: './api.ts' } } }));
  const result = await inspectApiModule(project.project, 'public-addon');

  assert.deepEqual(result.shape.members.symbols, { kind: 'value', value: ['gold', { digits: 2 }] });
});

for (const [name, source, diagnostic] of [
  ['sync function', 'export function value():number { return 1; }', /must return Promise/],
  ['class instance', 'class Value {} export const value = new Value();', /unsupported public value/],
  ['class argument', 'class Value {} export async function value(arg:Value):Promise<void> {}', /unsupported transport type/],
  ['mutable constants', 'export const value = { amount:1 };', /must be readonly/],
  ['dynamic constants', 'export const value = Math.random();', /static JSON literal/],
  ['unknown result', 'export async function value():Promise<unknown> { return null; }', /unsupported transport type/],
  ['noncallable state subscription', 'export const value:{ get():string|undefined; subscribe:string } = null!;', /subscribe must accept/],
  ['state listener mismatch', 'export const value:{ get():string|undefined; subscribe(listener:(next:string)=>void):()=>void } = null!;', /listener values must match/],
  ['state missing unsubscribe', 'export const value:{ get():string|undefined; subscribe(listener:(next:string|undefined)=>void):void } = null!;', /must return a zero-argument unsubscribe/],
  ['observable explicit removal', 'export const value:{ get():string|undefined; subscribe(listener:(next:string|undefined)=>void):()=>void; unsubscribe(listener:(next:string|undefined)=>void):void } = null!;', /observables expose only get and subscribe/],
  ['event missing unsubscribe', 'export const value:{ subscribe(listener:(payload:string)=>void):void } = null!;', /must return a zero-argument unsubscribe/],
  ['mismatched explicit removal', 'export const value:{ subscribe(listener:(payload:string)=>void):void; unsubscribe(listener:(payload:number)=>void):void } = null!;', /toSignal/],
  ['invalid subscription token', 'export const value:{ subscribe(listener:(payload:string)=>void):number; unsubscribe(listener:(payload:string)=>void):void } = null!;', /toSignal/],
  ['remote filter options', 'export const value:{ subscribe(listener:(payload:string)=>void, options?:{filter:string}):()=>void } = null!;', /do not support filter options/],
  ['event namespace listener', 'export const value:{ subscribe(listener:(payload:string,from:string)=>void):()=>void } = null!;', /accept one payload parameter/],
]) {
  test(`unsupported ${name} gives an actionable public export diagnostic`, async (t) => {
    const project = await fixture(t);

    await writeFile(project.source, project.poison + source);
    await assert.rejects(inspectApiModule(project.project, 'public-addon'), diagnostic);
    await assert.rejects(access(project.marker), { code: 'ENOENT' });
  });
}

test('UI compilers instantiate inert API clients and reject calls during authored evaluation', async (t) => {
  const project = await fixture(t);
  const entry = await put(project.project, 'entry.ts', `import { core } from '@bedrock-core/server-runtime'; import { info, currency } from 'public-addon'; core.register({ manifest:{namespace:'local'}, title:info.currency, current:currency.get() });`);
  const options = { root: project.project, dependencyRoot: project.project, source: entry, moduleNames: ['public-addon'] };
  const declaration = await bundleUiDeclaration(options);
  const file = await put(project.project, 'declaration.mjs', declaration.code);
  const captured = await readUiDeclaration(file);

  assert.equal(captured.declaration.title, 'gold');
  await writeFile(entry, 'import { balance } from "public-addon"; await balance("one"); export default 1;');
  const module = await bundleUiModule({ ...options, exports: {} });
  const evaluated = await put(project.project, 'evaluated.mjs', module.code);

  await assert.rejects(import(pathToFileURL(evaluated).href), /unavailable during evaluation/);
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('warm runtime compilation tracks package exports, API source and type-contract changes', async (t) => {
  const project = await fixture(t);

  project.behavior.dependencies.push({ module_name: 'public-addon' });
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { balance, info } from "public-addon";');
  await project.save();
  const options = { configPath: project.configPath, logger: {} };
  const cold = await runBuild(options);
  const warm = await runBuild(options);

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  await writeFile(project.source, project.poison + api.replace('currency:\'gold\'', 'currency:\'silver\''));
  const changed = await runBuild(options);

  assert.equal(changed.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.match(await readFile(path.join(changed.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /silver/);
  const declaration = await put(project.project, 'node_modules/public-addon/api.d.ts', 'export { balance } from "./contract"; export declare const info: { readonly currency:"declarations" };');
  const contract = await put(project.project, 'node_modules/public-addon/contract.d.ts', 'export declare function balance(id:string):Promise<number>;');
  const metadataPath = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  await writeFile(metadataPath, JSON.stringify({ ...metadata, exports: { ...metadata.exports, '.': { types: './api.d.ts', default: './api.ts' } } }));
  const reexport = await runBuild(options);
  const typeWarm = await runBuild(options);

  assert.equal(reexport.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.equal(typeWarm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  assert.match(await readFile(path.join(reexport.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /declarations/);
  await writeFile(contract, 'export declare function balance(id:string):Promise<string>;');
  const typeChanged = await runBuild(options);

  assert.equal(typeChanged.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.doesNotMatch(await readFile(path.join(typeChanged.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /"contract"|parameters.*result/);
  assert(typeChanged.dependencies.includes(declaration));
  assert(typeChanged.dependencies.includes(contract));
  await writeFile(contract, 'export declare function balance(id:string):Promise<symbol>;');
  await assert.rejects(runBuild(options), /unsupported transport type/);
  const native = JSON.parse(await readFile(path.join(cold.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert(native.dependencies.some(dependency => dependency.uuid === project.provider.header.uuid));
  assert(native.dependencies.every(dependency => dependency.module_name !== 'public-addon'));
  await assert.rejects(access(project.marker), { code: 'ENOENT' });
});

test('API declarations publish root and subpath objects during setup and omit bundled API TypeScript', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'package.json', JSON.stringify({ name: 'own-addon', type: 'module', exports: { '.': './packs/gameplay/api/index.ts', './math': './packs/gameplay/api/math.ts', './manifest.json': './packs/gameplay/manifest.json' } }));
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import {core,registerModule} from '@bedrock-core/server-runtime'; import {API} from '../api/index'; import {math} from '../api/math'; globalThis.entrySetup = 'ready'; core.register({api:registerModule(API),math:registerModule(math)});`);
  await put(project.project, 'packs/gameplay/api/index.ts', 'const __coreApiDefine = 0; export const API = { async read():Promise<number> { return 7 + __coreApiDefine; } }; export const title = "own";');
  await put(project.project, 'packs/gameplay/api/math.ts', 'export const math = { async twice(n:number):Promise<number> { return n*2; } };');
  await project.save();
  const output = await runBuild({ configPath: project.configPath, logger: {} });
  const warm = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');

  globalThis.apiModules = [];
  t.after(() => {
    delete globalThis.apiModules;
    delete globalThis.entrySetup;
  });
  const code = await readFile(path.join(output.outputPaths.gameplay, 'scripts/main.js'), 'utf8');
  const module = await put(project.project, 'provider.mjs', code);

  await import(pathToFileURL(module).href);
  assert.deepEqual(globalThis.apiModules.map(module => [module.moduleName, module.setup]), [['own-addon', 'ready'], ['own-addon/math', 'ready']]);
  assert.equal(await globalThis.apiModules[0].exports.API.read(), 7);
  await assert.rejects(access(path.join(output.outputPaths.gameplay, 'api/index.ts')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(output.outputPaths.gameplay, 'api/math.ts')), { code: 'ENOENT' });
});

test('exporting API objects prepares metadata without publishing an unregistered API', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'package.json', JSON.stringify({ name: 'unregistered-addon', type: 'module', exports: { '.': './packs/gameplay/api/index.ts', './manifest.json': './packs/gameplay/manifest.json' } }));
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import {core} from '@bedrock-core/server-runtime'; import {API} from '../api/index'; core.register({manifest:{}}); globalThis.entrySetup = API.read();`);
  await put(project.project, 'packs/gameplay/api/index.ts', 'export const API = { async read():Promise<number> { return 7; } };');
  await project.save();
  const output = await runBuild({ configPath: project.configPath, logger: {} });

  globalThis.apiModules = [];
  t.after(() => {
    delete globalThis.apiModules;
    delete globalThis.entrySetup;
  });
  const code = await readFile(path.join(output.outputPaths.gameplay, 'scripts/main.js'), 'utf8');
  const module = await put(project.project, 'unregistered.mjs', code);

  await import(pathToFileURL(module).href);
  assert.equal(await globalThis.entrySetup, 7);
  assert.deepEqual(globalThis.apiModules, []);
});

test('API metadata preserves project loaders that transform the provider implementation', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'package.json', JSON.stringify({ name: 'loaded-addon', type: 'module', exports: { '.': './packs/gameplay/api/index.ts', './manifest.json': './packs/gameplay/manifest.json' } }));
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import {core,registerModule} from '@bedrock-core/server-runtime'; import {API} from '../api/index'; core.register({api:registerModule(API)});`);
  await put(project.project, 'packs/gameplay/api/index.ts', 'export const API = { async read():Promise<number> { return 7; } };');
  await project.save();
  const output = await runBuild({ configPath: project.configPath, logger: {}, stages: {
    bundler(context, settings) {
      context.registerBundleExtension({ id: 'fixture:api-loader', version: '1', cache: true, plugins: [{
        name: 'api-implementation-loader', setup(build) {
          build.onLoad({ filter: /[\\/]api[\\/]index\.ts$/ }, async ({ path: file }) => ({
            contents: (await readFile(file, 'utf8')).replace('return 7;', 'return 11;'),
            loader: 'ts', watchFiles: [file],
          }));
        },
      }] });

      return runBundler(context, settings);
    },
  } });

  globalThis.apiModules = [];
  t.after(() => {
    delete globalThis.apiModules;
  });
  const code = await readFile(path.join(output.outputPaths.gameplay, 'scripts/main.js'), 'utf8');
  const file = await put(project.project, 'loaded.mjs', code);

  await import(pathToFileURL(file).href);
  assert.equal(await globalThis.apiModules[0].exports.API.read(), 11);
});

test('a mixed project exporting a resource manifest does not auto-bind unrelated behavior scripts', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'package.json', JSON.stringify({ name: 'resource-addon', type: 'module', exports: { '.': './packs/gameplay/api/index.ts', './manifest.json': './packs/visuals/manifest.json' } }));
  await put(project.project, 'packs/gameplay/api/index.ts', 'throw new Error("UNRELATED_API"); export function syncOnly():number { return 1; }');
  const output = await runBuild({ configPath: project.configPath, logger: {} });
  const code = await readFile(path.join(output.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  assert.doesNotMatch(code, /UNRELATED_API|provideApiModule/);
  await access(path.join(output.outputPaths.gameplay, 'api/index.ts'));
  await put(project.project, 'node_modules/public-addon/manifest.json', JSON.stringify(project.resources));
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /scripted Core manifest/);
});

test('each public export binds only to its owning behavior pack and cross-pack imports need their own dependency', async (t) => {
  const project = await fixture(t);
  const primary = { ...project.provider, namespace: 'primary_api' };
  const secondary = { ...manifestFor('script'), namespace: 'secondary_api' };
  const exports = {
    '.': './packs/primary/scripts/api.ts',
    './math': './packs/primary/scripts/math.ts',
    './stats': './packs/secondary/scripts/api.ts',
    './manifest.json': './packs/primary/manifest.json',
    './stats/manifest.json': './packs/secondary/manifest.json',
  };
  const root = path.join(project.project, 'node_modules/public-addon');

  await put(root, 'package.json', JSON.stringify({ name: 'public-addon', type: 'module', exports }));
  await put(root, 'packs/primary/manifest.json', JSON.stringify(primary));
  await put(root, 'packs/secondary/manifest.json', JSON.stringify(secondary));
  await put(root, 'packs/primary/scripts/api.ts', 'export async function read():Promise<number> { return 1; }');
  await put(root, 'packs/primary/scripts/math.ts', 'export async function twice(n:number):Promise<number> { return n*2; }');
  await put(root, 'packs/secondary/scripts/api.ts', 'export async function score():Promise<number> { return 2; }');
  const first = await apiExports(root, primary);
  const second = await apiExports(root, secondary);

  assert.deepEqual(first.modules.map(module => module.moduleName), ['public-addon', 'public-addon/math']);
  assert.deepEqual(second.modules.map(module => module.moduleName), ['public-addon/stats']);
  assert.equal(second.modules[0].uuid, secondary.header.uuid);
  await put(project.project, 'entry.ts', 'export { score } from "public-addon/stats";');
  await assert.rejects(bundleScripts({ root: project.project, entry: 'entry.ts', outfile: 'invalid.mjs', moduleNames: ['public-addon'] }), /belongs to another script pack/);
  const valid = await bundleScripts({ root: project.project, entry: 'entry.ts', outfile: 'valid.mjs', moduleNames: ['public-addon', 'public-addon/stats'] });

  assert.match(await readFile(valid.files.find(file => file.endsWith('.mjs')), 'utf8'), /secondary_api/);
  const inspected = await inspectApiModule(project.project, 'public-addon/stats');

  assert.equal(inspected.namespace, secondary.namespace);
  assert(inspected.inputs.includes(path.join(root, 'packs/secondary/manifest.json')));

  project.behavior.dependencies.push({ module_name: 'public-addon' });
  project.behavior.optionalDependencies = [{ module_name: 'public-addon/stats' }];
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export { read } from "public-addon"; export { score } from "public-addon/stats";');
  await project.save();
  const options = { configPath: project.configPath, logger: {} };
  const cold = await runBuild(options);
  const warm = await runBuild(options);

  assert.equal(warm.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  const native = JSON.parse(await readFile(path.join(cold.outputPaths.gameplay, 'manifest.json'), 'utf8'));

  assert(native.dependencies.some(dependency => dependency.uuid === primary.header.uuid));
  assert(!native.dependencies.some(dependency => dependency.uuid === secondary.header.uuid));
  secondary.namespace = 'secondary_updated';
  secondary.header.version = '2.0.0';
  await put(root, 'packs/secondary/manifest.json', JSON.stringify(secondary));
  const updated = await runBuild(options);

  assert.equal(updated.stages.find(stage => stage.stage === 'bundler').status, 'executed');
  assert.match(await readFile(path.join(updated.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /secondary_updated/);
  await put(root, 'packs/secondary/scripts/manifest.json', JSON.stringify(secondary));
  await assert.rejects(inspectApiModule(project.project, 'public-addon/stats'), /must export its owning pack manifest/);
  await assert.rejects(runBuild(options), /must export its owning pack manifest/);
});

test('package-name, scripted namespace and explicit subpath checks prevent ambiguous API routes', async (t) => {
  const project = await fixture(t);
  const metadataPath = path.join(project.project, 'node_modules/public-addon/package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  await writeFile(metadataPath, JSON.stringify({ ...metadata, name: 'other-name' }));
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /exact installed package name/);
  await writeFile(metadataPath, JSON.stringify(metadata));
  await put(project.project, 'node_modules/public-addon/manifest.json', JSON.stringify({ ...project.provider, namespace: undefined }));
  await assert.rejects(inspectApiModule(project.project, 'public-addon'), /scripted Core manifest/);
  await put(project.project, 'node_modules/public-addon/manifest.json', JSON.stringify(project.provider));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, exports: { './*': './*.ts', './manifest.json': './manifest.json' } }));
  await assert.rejects(inspectApiModule(project.project, 'public-addon/math'), /explicit package subpaths/);
});
