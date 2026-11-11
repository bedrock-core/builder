import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, type BuildOptions, transform } from 'esbuild';
import ts from 'typescript';
import { instrument } from './transform.ts';
import { API, ModuleKind, ModuleResolutionKind } from 'typescript-native/sync';
import { instrument as instrumentNative } from '../../packages/bundler/src/native-access-transform.ts';
import { acceptanceDependencies, installedPackage } from '../../test-support/acceptance.ts';
export const fixture = fileURLToPath(new URL('./', import.meta.url));

const dependencies = acceptanceDependencies(path.resolve(fixture, '../..'), 'acceptance', ['@minecraft/server', '@bedrock-core/server-runtime']);
const sdk = installedPackage(dependencies, '@minecraft/server');
const runtime = installedPackage(dependencies, '@bedrock-core/server-runtime');
const runtimeModule = '@bedrock-core/server-runtime/api/native-access';

export const runtimeAliases = { [runtimeModule]: createRequire(path.join(runtime, 'package.json')).resolve(runtimeModule) };

export const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, noEmit: true, skipLibCheck: true, types: [], allowImportingTsExtensions: true,
  baseUrl: fixture, paths: { '@minecraft/server': [path.join(sdk, 'index.d.ts')], [runtimeModule]: [runtimeAliases[runtimeModule]] },
};

/** Check the production native-TypeScript transformer against the same isolated fixture. */
export async function compileNativeFixture(directory = fixture) {
  using api = new API();
  const roots = [...(await runtimeSources([path.join(directory, 'authored.ts')], { absWorkingDir: directory, platform: 'node', alias: {
    '@prototype/native-access-helper': path.join(directory, 'dependency/index.ts'),
    '@prototype/native-access-js/commonjs': path.join(directory, 'javascript-dependency/commonjs.cjs'),
    '@prototype/native-access-js': path.join(directory, 'javascript-dependency/index.js'),
  } })).keys()];
  const program = api.createProgram(roots, {
    target: ts.ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, types: [], allowJs: true, allowImportingTsExtensions: true,
    pathsBasePath: directory, paths: compilerOptions.paths,
  });

  return await compileFixture(directory, (_legacy, source, runtimeImport, format) => {
    const nativeSource = program.getSourceFile(source.fileName);

    if (!nativeSource) {
      return {

        code: source.getFullText(), operations: {} };
    }

    return instrumentNative(program, nativeSource, runtimeImport, api.printer, format);
  });
}

/** Discover runtime inputs as the bundler resolves them, including JavaScript hidden by declarations. */
export async function runtimeSources(entryPoints: string[], options: BuildOptions = {}) {
  const cwd = path.resolve(options.absWorkingDir ?? process.cwd());
  const result = await build({ ...options, alias: { ...runtimeAliases, ...options.alias }, absWorkingDir: cwd, entryPoints, bundle: true, write: false, metafile: true, platform: options.platform ?? 'neutral', external: ['@minecraft/server', ...options.external ?? []] });

  return new Map(Object.entries(result.metafile.inputs).map(([file, input]) => [path.resolve(cwd, file), input.format]));
}

export async function compileFixture(directory = fixture, transformSource = instrument) {
  const files = ['authored.ts', 'library.ts'].map(name => path.join(directory, name));
  const alias = {
    ...runtimeAliases,
    '@prototype/native-access-helper': path.join(directory, 'dependency/index.ts'),
    '@prototype/native-access-js/commonjs': path.join(directory, 'javascript-dependency/commonjs.cjs'),
    '@prototype/native-access-js': path.join(directory, 'javascript-dependency/index.js'),
  };
  const options = { ...compilerOptions, allowJs: true, paths: { ...compilerOptions.paths,
    '@prototype/native-access-helper': [path.join(directory, 'dependency/index.ts')],
    '@prototype/native-access-js': [path.join(directory, 'javascript-dependency/index.d.ts')],
    '@prototype/native-access-js/commonjs': [path.join(directory, 'javascript-dependency/commonjs.d.cts')],
  } };
  const runtime = await runtimeSources([files[0]], { absWorkingDir: directory, alias, platform: 'node' });
  const roots = [...files, ...[...runtime.keys()].filter(file => /\.[cm]?js$/.test(file))];
  const program = ts.createProgram(roots, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length) {
    throw new Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => fixture, getNewLine: () => '\n' }));
  }

  const instrumented = new Map(program.getSourceFiles().filter(file => !file.isDeclarationFile).map((source) => {
    let runtimeImport = path.relative(path.dirname(source.fileName), path.join(directory, 'runtime')).replaceAll('\\', '/');

    if (!runtimeImport.startsWith('.')) {
      runtimeImport = `./${runtimeImport}`;
    }

    return [path.resolve(source.fileName), transformSource(program, source, runtimeImport, runtime.get(path.resolve(source.fileName)))];
  }));
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);

  host.getSourceFile = (file, ...args) => {
    const output = instrumented.get(path.resolve(file));

    return output ? ts.createSourceFile(file, output.code, ts.ScriptTarget.Latest, true) : original(file, ...args);
  };

  const checked = ts.createProgram(roots, options, host);
  const emittedDiagnostics = ts.getPreEmitDiagnostics(checked);

  if (emittedDiagnostics.length) {
    throw new Error(ts.formatDiagnostics(emittedDiagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => fixture, getNewLine: () => '\n' }));
  }

  const result = await build({
    stdin: { contents: `export * from ${JSON.stringify(files[0])}; export { nativeAccess as access } from ${JSON.stringify(path.join(directory, 'runtime.ts'))};`, resolveDir: directory, sourcefile: 'prototype-entry.ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node', external: ['@minecraft/server'],
    alias,
    plugins: [{ name: 'native-access-prototype', setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
        const output = instrumented.get(args.path);

        return output ? { contents: output.code, loader: /\.[cm]?js$/.test(args.path) ? 'js' : 'ts', resolveDir: path.dirname(args.path) } : undefined;
      });
    } }],
  });
  const baseline = await transform(await readFile(path.join(directory, 'baseline.ts'), 'utf8'), { loader: 'ts', format: 'cjs' });

  return { code: result.outputFiles[0].text, baseline: baseline.code, instrumented };
}

export function evaluate(code: string, minecraft: object): Record<string, unknown> {
  const module = { exports: {} };

  vm.runInNewContext(code, { module, exports: module.exports, require(name: string) {
    if (name === '@minecraft/server') {
      return minecraft;
    }

    throw new Error(`Unexpected prototype import: ${name}`);
  } });

  return module.exports;
}

export function fakeEngine(options: { blockInventoryLifetime?: 'replaced' | 'location' } = {}) {
  type Item = { typeId: string; amount: number };
  type InventoryData = { items: (Item | undefined)[] };
  const entities = new Map<string, {
    items: (Item | undefined)[];
    tags: Set<string>;
  }>();
  const blocks = new Map<string, { typeId: string; inventory?: InventoryData }>();
  const blockKey = (dimension: string, location: { x: number; y: number; z: number }): string => `${dimension}:${location.x},${location.y},${location.z}`;
  let sequence = 0;
  let spawnCount = 0;

  const realm = () => {
    let lastSlot: unknown;
    const spawns = new Set<(event: { entity: Entity }) => void>();

    class ItemStack {
      typeId: string;
      amount: number;
      constructor(typeId: string, amount = 1) {
        this.typeId = typeId;
        this.amount = amount;
      }
    }
    class Entity {
      readonly id: string;
      constructor(id: string) { this.id = id; }
      get isValid() { return entities.has(this.id); }
      getComponent(id: string) {
        if (!this.isValid) {
          throw new Error('invalid entity');
        }

        return id === 'minecraft:inventory' ? new Inventory(this) : undefined;
      }

      addTag(tag: string) { entities.get(this.id)!.tags.add(tag); }
      remove() { entities.delete(this.id); }
    }
    class Inventory {
      readonly typeId = 'minecraft:inventory';
      readonly entity: Entity;
      constructor(entity: Entity) { this.entity = entity; }
      get container() {
        const data = entities.get(this.entity.id)!;

        return new Container(() => data.items, () => entities.get(this.entity.id) === data);
      }
    }
    class BlockInventory {
      readonly typeId = 'minecraft:inventory';
      readonly block: Block;
      #data: InventoryData;
      constructor(block: Block, data: InventoryData) {
        this.block = block;
        this.#data = data;
      }

      get container() {
        const current = () => blocks.get(blockKey(this.block.dimension.id, this.block.location))?.inventory;
        const inventory = () => options.blockInventoryLifetime === 'location' ? current() : this.#data;

        return new Container(() => inventory()!.items,
          () => options.blockInventoryLifetime === 'location' ? current() !== undefined : current() === this.#data);
      }
    }
    class Container {
      #items: () => (Item | undefined)[];
      #valid: () => boolean;
      constructor(items: () => (Item | undefined)[], valid: () => boolean) {
        this.#items = items;
        this.#valid = valid;
      }

      get isValid() { return this.#valid(); }
      getSlot(index: number) {
        if (!this.isValid) {
          throw new Error('invalid container');
        }

        if (!Number.isSafeInteger(index) || index < 0 || index >= 9) {
          throw new Error('invalid slot');
        }

        lastSlot = new ContainerSlot(this.#items, index, this.#valid);

        return lastSlot;
      }
    }
    class ContainerSlot {
      #items: () => (Item | undefined)[];
      #index: number;
      #valid: () => boolean;
      constructor(items: () => (Item | undefined)[], index: number, valid: () => boolean) {
        this.#items = items;
        this.#index = index;
        this.#valid = valid;
      }

      get isValid() { return this.#valid(); }
      setItem(item?: ItemStack) {
        if (!this.isValid) {
          throw new Error('invalid slot');
        }

        this.#items()[this.#index] = item ? { typeId: item.typeId, amount: item.amount } : undefined;
      }

      getItem() {
        if (!this.isValid) {
          throw new Error('invalid slot');
        }

        const value = this.#items()[this.#index];

        return value ? new ItemStack(value.typeId, value.amount) : undefined;
      }
    }
    class Dimension {
      readonly id = 'minecraft:overworld';
      getBlock(location: { x: number; y: number; z: number }) { return new Block(this, { ...location }); }
      spawnEntity() {
        const id = String(++sequence);

        entities.set(id, { items: [], tags: new Set() });
        spawnCount++;
        const entity = new Entity(id);

        for (const listener of [...spawns]) {
          listener({ entity });
        }

        return entity;
      }
    }
    class Block {
      readonly dimension: Dimension;
      readonly location: { x: number; y: number; z: number };
      constructor(dimension: Dimension, location: { x: number; y: number; z: number }) {
        this.dimension = dimension;
        this.location = location;
      }

      get isValid() { return true; }
      get typeId() { return blocks.get(blockKey(this.dimension.id, this.location))?.typeId ?? 'minecraft:air'; }
      setType(typeId: string) {
        blocks.set(blockKey(this.dimension.id, this.location), { typeId, inventory: typeId === 'minecraft:chest' ? { items: [] } : undefined });
      }

      getComponent(id: string) {
        const data = blocks.get(blockKey(this.dimension.id, this.location));

        return id === 'minecraft:inventory' && data?.inventory ? new BlockInventory(this, data.inventory) : undefined;
      }
    }
    const dimension = new Dimension();
    const minecraft = { Entity, Dimension, Block, ItemStack, ContainerSlot, world: {
      getDimension: () => dimension,
      getEntity: (id: string) => entities.has(id) ? new Entity(id) : undefined,
      afterEvents: { entitySpawn: {
        subscribe(listener: (event: { entity: Entity }) => void) {
          spawns.add(listener);

          return listener;
        },
        unsubscribe(listener: (event: { entity: Entity }) => void) { spawns.delete(listener); },
      } },
    } };

    return { minecraft, get lastSlot() {
      return lastSlot;
    }, get spawnSubscriptions() { return spawns.size; } };
  };

  return { realm, get spawnCount() {
    return spawnCount;
  } };
}
