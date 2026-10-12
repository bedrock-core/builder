import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildResult } from './contract.d.ts';
import type { CacheOptions, CacheResult } from '@bedrock-core/builder-plugin';
export type { CacheOptions, CacheOutput, CacheResult } from '@bedrock-core/builder-plugin';

const locations = new WeakMap<BuildResult, ReadonlySet<string>>();

export function trackLocations(result: BuildResult, paths: ReadonlySet<string>): void {
  locations.set(result, paths);
}

export function inputLocations(result: BuildResult): ReadonlySet<string> {
  return locations.get(result) ?? new Set();
}

export interface FileCacheOptions {
  directory: string;
  /** Named roots let records survive replacement of a temporary workspace. */
  roots: Readonly<Record<string, string>>;
  enabled?: boolean;
  signal?: AbortSignal;
  warn?: (message: string) => void;
  dependency?: (file: string, location: boolean) => void;
  scope?: () => string;
}

interface Location {
  root: string;
  path: string;
}
interface Input extends Location {
  hash: string;
}
interface Output extends Location {
  content: string;
  hash: string;
}
interface RecordEntry {
  key: string;
  seeds: Location[];
  inputs: Input[];
  files: Output[];
  value: unknown;
  hash: string;
}

export interface FileCache {
  readonly results: { id: string; status: 'executed' | 'cached' }[];
  reuse<T>(id: string, options: CacheOptions<T>): Promise<CacheResult<T>>;
  /** Clear shared input snapshots after another stage can modify staging. */
  boundary(): void;
  save(): Promise<void>;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function json(value: unknown): string {
  const seen = new Set<object>();

  function inspect(item: unknown): void {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || item === undefined
      || (typeof item === 'number' && !Number.isFinite(item))) {
      throw new Error('Cached file values must contain only JSON data');
    }

    if (item === null || typeof item !== 'object') {
      return;
    }

    if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) {
      throw new Error('Cached file values must contain only JSON data');
    }

    seen.add(item);

    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (!descriptor.enumerable) {
        continue;
      }

      if (descriptor.get || descriptor.set) {
        throw new Error('Cached file values must contain only JSON data');
      }

      inspect(descriptor.value);
    }

    seen.delete(item);
  }

  inspect(value);

  return JSON.stringify(value);
}

async function regularParents(file: string): Promise<boolean> {
  let directory = path.dirname(file);

  while (true) {
    try {
      const info = await lstat(directory);

      if (info.isSymbolicLink() || !info.isDirectory()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      return true;
    }

    directory = parent;
  }
}

/** Keep dependency fingerprints and compiled contents across successful builds. */
export async function createFileCache(options: FileCacheOptions): Promise<FileCache> {
  const roots = Object.entries(options.roots).map(([name, root]) => [name, path.resolve(root)] as const)
    .sort((a, b) => b[1].length - a[1].length);
  const file = path.join(options.directory, 'files.json');
  const entries = path.join(options.directory, 'entries');
  const implementation = digest(await readFile(new URL(import.meta.url)));
  let enabled = options.enabled !== false && await regularParents(file) && await regularParents(path.join(entries, 'entry.json'));
  let previous: Record<string, string> = {};
  const current: Record<string, RecordEntry | string> = Object.create(null);
  const used = new Set<string>();
  const snapshots = new Map<string, Promise<string | undefined>>();
  const identities = new Map<string, boolean>();
  const results: FileCache['results'] = [];

  function location(file: string): Location {
    const absolute = path.resolve(file);
    const root = roots.find(([, directory]) => inside(directory, absolute));

    return root
      ? { root: root[0], path: path.relative(root[1], absolute).replaceAll('\\', '/') }
      : { root: '$external', path: absolute };
  }

  function resolve(value: Location, output = false): string | undefined {
    if (!value || typeof value.path !== 'string') {
      return;
    }

    if (value.root === '$external') {
      return !output && path.isAbsolute(value.path) ? value.path : undefined;
    }

    const root = roots.find(([name]) => name === value.root)?.[1];
    const file = root && path.resolve(root, value.path);

    return root && file && inside(root, file) ? file : undefined;
  }

  async function snapshot(file: string): Promise<string | undefined> {
    if (!snapshots.has(file)) {
      snapshots.set(file, (async () => {
        options.signal?.throwIfAborted();

        try {
          const info = await lstat(file);

          identities.set(file, info.isDirectory() || info.isSymbolicLink());

          if (info.isSymbolicLink()) {
            return `link:${await readlink(file)}`;
          }

          if (info.isDirectory()) {
            return 'directory';
          }

          if (!info.isFile()) {
            return;
          }

          return digest(await readFile(file));
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            identities.set(file, false);

            return 'missing';
          }

          throw error;
        }
      })());
    }

    return snapshots.get(file)!;
  }

  async function report(inputs: readonly string[]): Promise<void> {
    if (!options.dependency) {
      return;
    }

    for (const file of inputs) {
      if (!identities.has(file)) {
        try {
          const info = await lstat(file);

          identities.set(file, info.isDirectory() || info.isSymbolicLink());
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
          }

          identities.set(file, false);
        }
      }

      options.dependency(file, identities.get(file)!);
    }
  }

  if (enabled) {
    try {
      const info = await lstat(file);

      if (!info.isFile() || info.isSymbolicLink()) {
        enabled = false;
      } else {
        const record = JSON.parse(await readFile(file, 'utf8')) as { version?: number; files?: Record<string, string> };

        if (record.version === 2 && record.files && typeof record.files === 'object') {
          previous = record.files;
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.warn?.(`Unable to read file cache: ${String(error)}`);
      }
    }
  }

  async function readEntry(reference: unknown): Promise<RecordEntry | undefined> {
    if (typeof reference !== 'string' || !/^[a-f0-9]{64}$/.test(reference)) {
      return;
    }

    const file = path.join(entries, `${reference}.json`);

    try {
      const info = await lstat(file);

      if (!info.isFile() || info.isSymbolicLink()) {
        return;
      }

      const record = JSON.parse(await readFile(file, 'utf8')) as RecordEntry;

      return record?.hash === reference ? record : undefined;
    } catch (error) {
      options.signal?.throwIfAborted();

      if (!(error instanceof SyntaxError) && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        options.warn?.(`Unable to read compiled cache entry: ${String(error)}`);
      }
    }
  }

  return {
    results,
    boundary() {
      snapshots.clear();
      identities.clear();
    },
    async reuse<T>(id: string, compilation: CacheOptions<T>): Promise<CacheResult<T>> {
      options.signal?.throwIfAborted();
      const scope = options.scope?.();

      id = scope ? `${scope}/${id}` : id;

      if (typeof id !== 'string' || !id.trim() || used.has(id)) {
        throw new Error(`Cache ID must be nonempty and unique in a build: ${id}`);
      }

      used.add(id);
      const seeds = [...new Set(compilation.inputs.map(file => path.resolve(file)))].sort().map(location);
      const key = digest(json({ node: process.versions.node, implementation, key: compilation.key ?? null }));
      const reference = previous[id];
      const candidate = enabled && compilation.cache !== false ? await readEntry(reference) : undefined;
      let hit = enabled && compilation.cache !== false && candidate?.key === key
        && JSON.stringify(candidate.seeds) === JSON.stringify(seeds);

      if (hit && candidate) {
        try {
          const { hash, ...body } = candidate;

          hit = digest(json(body)) === hash && Array.isArray(candidate.inputs) && Array.isArray(candidate.files);

          for (const input of hit ? candidate.inputs : []) {
            const source = resolve(input);

            if (!source || await snapshot(source) !== input.hash) {
              hit = false;
              break;
            }
          }

          for (const output of hit ? candidate.files : []) {
            const destination = resolve(output, true);

            if (!destination || typeof output.content !== 'string'
              || digest(Buffer.from(output.content, 'base64')) !== output.hash || !await regularParents(destination)) {
              hit = false;
              break;
            }

            try {
              const info = await lstat(destination);

              if (!info.isFile() || info.isSymbolicLink()) {
                hit = false;
                break;
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            }
          }
        } catch {
          options.signal?.throwIfAborted();
          hit = false;
        }
      }

      if (hit && candidate) {
        const files: string[] = [];
        const inputs = candidate.inputs.map(input => resolve(input)!);

        for (const output of candidate.files) {
          options.signal?.throwIfAborted();
          const destination = resolve(output, true)!;

          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, Buffer.from(output.content, 'base64'));
          snapshots.delete(destination);
          files.push(destination);
        }

        current[id] = reference;
        await report(inputs);
        results.push({ id, status: 'cached' });

        return { value: JSON.parse(json(candidate.value)) as T, cached: true, inputs, files };
      }

      const output = await compilation.run();

      options.signal?.throwIfAborted();
      const inputs = [...new Set([...compilation.inputs, ...(output.inputs ?? [])].map(file => path.resolve(file)))].sort();
      const files = [...new Set((output.files ?? []).map(file => path.resolve(file)))];

      results.push({ id, status: 'executed' });

      if (enabled && compilation.cache !== false && output.cache !== false) {
        const recordedInputs: Input[] = [];
        let cacheable = true;

        for (const file of inputs) {
          const hash = await snapshot(file);

          if (hash === undefined) {
            cacheable = false;
            break;
          }

          recordedInputs.push({ ...location(file), hash });
        }

        const recordedFiles: Output[] = [];

        for (const file of files) {
          const target = location(file);

          if (!resolve(target, true) || !await regularParents(file) || !(await lstat(file)).isFile()) {
            throw new Error(`Cached file output must be a regular file within its staging roots: ${file}`);
          }

          const content = await readFile(file);

          recordedFiles.push({ ...target, content: content.toString('base64'), hash: digest(content) });
          snapshots.delete(file);
        }

        if (cacheable) {
          const body = { key, seeds, inputs: recordedInputs, files: recordedFiles, value: output.value };

          current[id] = { ...body, hash: digest(json(body)) };
        }
      }

      await report(inputs);

      return { value: output.value, cached: false, inputs, files };
    },
    async save() {
      if (!enabled) {
        return;
      }

      const candidate = `${file}.${randomUUID()}.tmp`;

      try {
        options.signal?.throwIfAborted();

        if (!await regularParents(file) || !await regularParents(path.join(entries, 'entry.json'))) {
          return;
        }

        await mkdir(entries, { recursive: true });
        const records = { ...previous };

        // An output hit may skip its compiler entirely. Keep that compiler's record.
        for (const id of used) {
          if (!Object.hasOwn(current, id)) {
            delete records[id];
          }
        }

        // Store each compilation separately: large fixture projects exceed the
        // maximum JavaScript string size when all values share one JSON document.
        for (const [id, record] of Object.entries(current)) {
          options.signal?.throwIfAborted();

          if (typeof record === 'string') {
            records[id] = record;
            continue;
          }

          const output = path.join(entries, `${record.hash}.json`);
          const temporary = `${output}.${randomUUID()}.tmp`;

          try {
            await writeFile(temporary, json(record), { flag: 'wx' });
            await rename(temporary, output);
            records[id] = record.hash;
          } finally {
            await rm(temporary, { force: true });
          }
        }

        await writeFile(candidate, JSON.stringify({ version: 2, files: records }), { flag: 'wx' });
        options.signal?.throwIfAborted();
        await rename(candidate, file);

        const retained = new Set(Object.values(records));

        for (const reference of new Set(Object.values(previous))) {
          if (typeof reference === 'string' && /^[a-f0-9]{64}$/.test(reference) && !retained.has(reference)) {
            await rm(path.join(entries, `${reference}.json`), { force: true });
          }
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        options.warn?.(`Unable to save file cache: ${String(error)}`);
      } finally {
        await rm(candidate, { force: true });
      }
    },
  };
}
