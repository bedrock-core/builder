import { copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { readManifest, validatePackManifests } from './manifest.ts';
import { apiPackageMetadata } from '@bedrock-core/builder-manifest';

/** Validated pack sources and explicit export destinations for standalone publication. */
export interface ExportOptions {
  /** Pack IDs mapped to real source directories. */
  packs: Record<string, string>;
  /** Matching pack IDs mapped to destination directories; relative paths use the process working directory. */
  paths: Record<string, string>;
  /** Cooperative cancellation before or during publication. */
  signal?: AbortSignal;
  /** Variable values for %NAME%, $NAME and ${NAME}; defaults to process.env. */
  environment?: NodeJS.ProcessEnv;
}

/** Pack ID and absolute published destination. */
export interface ExportedPack {
  /** Configured pack ID. */
  id: string;
  /** Absolute published directory. */
  path: string;
}

type PublishPacks = (packs: Record<string, string>, signal?: AbortSignal, apiPackage?: string) => Promise<ExportedPack[]>;

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);

  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(await realpath(directory), directory) !== '') {
    throw new Error(`Export requires a real directory without symlink ancestors: ${directory}`);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  let existing = directory;

  while (!await exists(existing)) {
    existing = path.dirname(existing);
  }

  await assertDirectory(existing);
  await mkdir(directory, { recursive: true });
  await assertDirectory(directory);
}

function checkDestinations(paths: Record<string, string>): void {
  const destinations = Object.values(paths);

  if (!destinations.length) {
    throw new Error('Export needs at least one pack destination');
  }

  for (const [index, destination] of destinations.entries()) {
    if (/\.builder-/i.test(path.basename(destination))) {
      throw new Error('Export destinations cannot use reserved .builder- names');
    }

    if (path.dirname(destination) === destination) {
      throw new Error('Export must use a dedicated pack directory');
    }

    for (const other of destinations.slice(index + 1)) {
      if (contains(destination, other) || contains(other, destination)) {
        throw new Error('Pack export destinations must be separate directories');
      }
    }
  }
}

function checkPackIds(packs: Record<string, string>, paths: Record<string, string>): void {
  for (const id of Object.keys(paths)) {
    if (!Object.hasOwn(packs, id)) {
      throw new Error(`Export pack is not configured: ${id}`);
    }
  }

  for (const id of Object.keys(packs)) {
    if (!Object.hasOwn(paths, id)) {
      throw new Error(`Export destination is missing for pack: ${id}`);
    }
  }
}

function checkSources(packs: Record<string, string>, paths: Record<string, string>): void {
  for (const destination of Object.values(paths)) {
    for (const directory of Object.values(packs)) {
      const source = path.resolve(directory);

      if (contains(destination, source) || contains(source, destination)) {
        throw new Error('Pack sources and export destinations must be separate directories');
      }
    }
  }
}

function expandExportPath(directory: string, environment: NodeJS.ProcessEnv): string {
  return directory.replace(/%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_placeholder, windows: string | undefined, braced: string | undefined, bare: string | undefined) => {
    const name = windows ?? braced ?? bare!;

    if (windows === undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Unsupported export environment variable expression: ${name}`);
    }

    const key = process.platform === 'win32'
      ? Object.keys(environment).find(candidate => candidate.toLowerCase() === name.toLowerCase())
      : name;
    const value = key !== undefined && Object.hasOwn(environment, key) ? environment[key] : undefined;

    if (value === undefined || !value.trim()) {
      throw new Error(`Export environment variable is unset or empty: ${name}`);
    }

    return value;
  });
}

/**
 * Expand `%NAME%`, `$NAME` and `${NAME}`, then resolve destinations relative to the project.
 * @param project Absolute directory containing config.json.
 * @param packs Configured pack IDs mapped to their directories.
 * @param selection Destination for every configured pack ID.
 * @param environment Variable values; defaults to process.env.
 * @returns Absolute destinations without creating directories or publishing files.
 * @remarks Supports %NAME%, $NAME and ${NAME}. Environment names are case-insensitive on Windows. Missing variables, pack destinations and unsafe overlaps fail.
 * @throws For missing variables/pack IDs, overlapping paths or unsafe source destinations.
 */
export function resolveExportPaths(project: string, packs: Record<string, string>, selection: Record<string, string>, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  checkPackIds(packs, selection);
  const paths = Object.fromEntries(Object.entries(selection).map(([id, directory]) => [id, path.resolve(project, expandExportPath(directory, environment))]));

  validateDestinations(project, packs, paths);

  return paths;
}

function validateDestinations(project: string, packs: Record<string, string>, paths: Record<string, string>): void {
  checkDestinations(paths);

  for (const destination of Object.values(paths)) {
    if (contains(destination, project) || (contains(project, destination)
      && path.relative(project, destination).split(path.sep).some(part => ['.git', 'node_modules', '.bedrock-core'].includes(part)))) {
      throw new Error('Export must use a dedicated pack directory separate from project sources');
    }

    for (const source of Object.values(packs)) {
      const directory = path.resolve(project, source);

      if (contains(directory, destination) || contains(destination, directory)) {
        throw new Error('Pack sources and export destinations must be separate directories');
      }
    }
  }
}

/** Resolve a dedicated API package destination with the pack publication safety rules. */
export function resolveApiPackagePath(project: string, packs: Record<string, string>, paths: Record<string, string>, destination: string): string {
  const output = path.resolve(project, expandExportPath(destination, process.env));

  validateDestinations(project, packs, { ...paths, '\0api-package': output });

  return output;
}

async function inspectSource(root: string): Promise<Map<string, Dirent>> {
  const entries = new Map<string, Dirent>();

  async function visit(directory: string): Promise<void> {
    await assertDirectory(directory);

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`Export source contains a symlink: ${file}`);
      }

      entries.set(path.relative(root, file), entry);

      if (entry.isDirectory()) {
        await visit(file);
      }
    }
  }

  await visit(root);

  return entries;
}

/** Check the complete inventory and compare bytes before allocating publication snapshots. */
async function sameTree(source: string, destination: string, inputs: Map<string, Dirent>, outputs: Map<string, Dirent>, signal?: AbortSignal): Promise<boolean> {
  if (inputs.size !== outputs.size) {
    return false;
  }

  const files: string[] = [];

  for (const [file, input] of inputs) {
    const output = outputs.get(file);

    if (!output || (input.isDirectory() ? !output.isDirectory() : !input.isFile() || !output.isFile())) {
      return false;
    }

    if (input.isFile()) {
      files.push(file);
    }
  }

  for (let offset = 0; offset < files.length; offset += 8) {
    const compared = await Promise.allSettled(files.slice(offset, offset + 8).map(async (file) => {
      signal?.throwIfAborted();
      const paths = [path.join(source, file), path.join(destination, file)];
      const before = await Promise.all(paths.map(file => lstat(file)));

      if (!before.every(info => info.isFile()) || before[0].size !== before[1].size
        || !await sameContents(paths[0], paths[1], before[0].size, signal)) {
        return false;
      }

      const after = await Promise.all(paths.map(file => lstat(file)));

      return before.every((info, index) => {
        const current = after[index];

        return current.isFile() && current.dev === info.dev && current.ino === info.ino && current.size === info.size
          && current.mtimeMs === info.mtimeMs && current.ctimeMs === info.ctimeMs;
      });
    }));

    for (const result of compared) {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      if (!result.value) {
        return false;
      }
    }
  }

  return true;
}

async function apiPackageName(directory: string, packs?: Record<string, string>): Promise<string> {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
  const api = apiPackageMetadata(metadata);

  if (typeof metadata.name !== 'string' || !api) {
    throw new Error(`Export directory does not identify a portable API package: ${directory}`);
  }

  if (packs) {
    const identities = await Promise.all(Object.entries(packs).map(([id, directory]) => readManifest(id, directory)));

    for (const relative of new Set(Object.values(api.manifests))) {
      const file = path.resolve(directory, relative);

      if (!contains(directory, file)) {
        throw new Error('API owner manifests must stay inside the published package');
      }

      const owner = JSON.parse(await readFile(file, 'utf8')) as { header?: { uuid?: string; version?: unknown } };

      if (!identities.some(pack => pack.header.uuid === owner.header?.uuid && pack.header.version === owner.header.version)) {
        throw new Error(`API owner identity does not match a final pack manifest: ${relative}`);
      }
    }
  }

  return metadata.name;
}

async function updateFileSystem(operation: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();

    try {
      await operation();

      return;
    } catch (error) {
      if (attempt === 3 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }

      await delay(50 * (attempt + 1), undefined, { signal });
    }
  }
}

async function readChunk(file: FileHandle, buffer: Buffer, length: number, position: number, signal?: AbortSignal): Promise<number> {
  let read = 0;

  while (read < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, read, length - read, position + read);

    if (!bytesRead) {
      break;
    }

    read += bytesRead;
  }

  return read;
}

/** Compare exact bytes with bounded memory, including equal-size files with equal timestamps. */
async function sameContents(source: string, destination: string, size: number, signal?: AbortSignal): Promise<boolean> {
  const input = await open(source, 'r');

  try {
    const output = await open(destination, 'r');

    try {
      const left = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
      const right = Buffer.allocUnsafe(left.length);

      for (let position = 0; position < size; position += left.length) {
        const length = Math.min(left.length, size - position);
        const [a, b] = await Promise.all([readChunk(input, left, length, position, signal), readChunk(output, right, length, position, signal)]);

        if (a !== length || b !== length || !left.subarray(0, length).equals(right.subarray(0, length))) {
          return false;
        }
      }

      return (await output.stat()).size === size;
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Preserve directory and unchanged-file identities while applying a complete snapshot. */
async function synchronize(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await ensureDirectory(destination);
  const pending = new Set(await readdir(destination));
  const entries = await readdir(source, { withFileTypes: true });

  // Publish the root manifest after the files it can reference.
  entries.sort((a, b) => Number(a.name === 'manifest.json') - Number(b.name === 'manifest.json'));

  // Only inspection runs concurrently; mutations retain manifest-last order.
  for (let offset = 0; offset < entries.length; offset += 8) {
    const inspected = await Promise.allSettled(entries.slice(offset, offset + 8).map(async (entry) => {
      signal?.throwIfAborted();
      const input = path.join(source, entry.name);
      const output = path.join(destination, entry.name);
      const current = await lstat(output).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }

        return undefined;
      });
      let unchanged = false;

      if (!entry.isDirectory() && current?.isFile()) {
        const incoming = await lstat(input);

        unchanged = incoming.size === current.size && await sameContents(input, output, incoming.size, signal);
      }

      return { entry, input, output, current, unchanged };
    }));

    for (const result of inspected) {
      signal?.throwIfAborted();

      if (result.status === 'rejected') {
        throw result.reason;
      }

      const { entry, input, output, unchanged } = result.value;
      let { current } = result.value;

      pending.delete(entry.name);

      if (current?.isSymbolicLink()) {
        throw new Error(`Export destination contains a symlink: ${output}`);
      }

      if (current && current.isDirectory() !== entry.isDirectory()) {
        await updateFileSystem(() => rm(output, { recursive: true, force: true }), signal);
        current = undefined;
      }

      if (entry.isDirectory()) {
        await synchronize(input, output, signal);
      } else if (!unchanged) {
        if (current && (!current.isFile() || current.nlink > 1)) {
          throw new Error(`Export requires an independent regular file: ${output}`);
        }

        await updateFileSystem(() => copyFile(input, output), signal);
      }
    }
  }

  for (const name of pending) {
    signal?.throwIfAborted();
    await updateFileSystem(() => rm(path.join(destination, name), { recursive: true, force: true }), signal);
  }
}

async function publishPacks({ packs, paths, signal }: ExportOptions, api?: { source: string; path: string }): Promise<ExportedPack[]> {
  checkPackIds(packs, paths);
  await validatePackManifests(packs);
  const jobs: { path: string; candidate: string; backup?: string; started: boolean }[] = [];
  let workspace: string | undefined;
  let preserveBackups = false;

  try {
    const directories = Object.entries(packs).map(([id, source]) => ({ id, source, destination: paths[id]!, api: false }));

    if (api) {
      directories.push({ id: '\0api-package', source: api.source, destination: api.path, api: true });
    }

    for (const { id, source: directory, destination, api: isApi } of directories) {
      signal?.throwIfAborted();
      const source = path.resolve(directory);

      const inputs = await inspectSource(source);
      const packageName = isApi ? await apiPackageName(source, packs) : undefined;

      if (await exists(destination)) {
        const outputs = await inspectSource(destination);

        if (outputs.size) {
          try {
            if (isApi) {
              if (await apiPackageName(destination) !== packageName) {
                throw new Error('API package name does not match the existing export');
              }
            } else {
              await readManifest(id, destination);
            }
          } catch (cause) {
            throw new Error(`Export destination does not identify a pack: ${destination}`, { cause });
          }
        }

        if (await sameTree(source, destination, inputs, outputs, signal)) {
          continue;
        }
      }

      workspace ??= await mkdtemp(path.join(await realpath(tmpdir()), 'bedrock-core-export-'));
      const job = {
        path: destination, candidate: path.join(workspace, `${jobs.length}-next`),
        backup: await exists(destination) ? path.join(workspace, `${jobs.length}-previous`) : undefined,
        started: false,
      };

      jobs.push(job);
      await cp(source, job.candidate, { recursive: true });

      if (job.backup) {
        await cp(destination, job.backup, { recursive: true });
      }
    }

    for (const job of jobs) {
      signal?.throwIfAborted();

      job.started = true;
      await synchronize(job.candidate, job.path, signal);
    }

    signal?.throwIfAborted();

    return Object.keys(packs).map(id => ({ id, path: paths[id]! }));
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    for (const job of [...jobs].reverse()) {
      if (!job.started) {
        continue;
      }

      try {
        if (job.backup) {
          await synchronize(job.backup, job.path);
        } else {
          await updateFileSystem(() => rm(job.path, { recursive: true, force: true }));
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length) {
      preserveBackups = true;
      throw new AggregateError([error, ...rollbackErrors], `Export rollback failed; recovery files retained at ${workspace}`, { cause: error });
    }

    throw error;
  } finally {
    if (workspace && !preserveBackups) {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

/**
 * Hold destination locks while the callback prepares and publishes validated packs.
 * @param paths Dedicated nonoverlapping pack destination directories.
 * @param build Callback receiving the guarded publication function.
 * @returns The callback result, with destination locks released on completion.
 * @remarks Locks are keyed by destination in the OS temporary directory. The callback owns preparation and any additional validation.
 * @throws If a destination is unsafe or already locked, or the callback fails.
 */
export async function withExportPaths<T>(paths: Record<string, string>, build: (publish: PublishPacks) => Promise<T>, apiPath?: string): Promise<T> {
  paths = Object.fromEntries(Object.entries(paths).map(([id, directory]) => [id, path.resolve(directory)]));
  const destinations = apiPath ? { ...paths, '\0api-package': path.resolve(apiPath) } : paths;

  checkDestinations(destinations);
  const lockRoot = path.join(await realpath(tmpdir()), 'bedrock-core-export-locks');

  await ensureDirectory(lockRoot);
  const locks: string[] = [];

  try {
    for (const destination of Object.values(destinations).sort()) {
      await ensureDirectory(path.dirname(destination));

      if (await exists(destination)) {
        await assertDirectory(destination);
      }

      const identity = process.platform === 'win32' ? destination.toLowerCase() : destination;
      const lock = path.join(lockRoot, createHash('sha256').update(identity).digest('hex'));

      try {
        await mkdir(lock);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw cause;
        }

        throw Object.assign(new Error(`Export destination is locked: ${destination}; lock: ${lock}`, { cause }), { code: 'EEXIST' });
      }

      locks.push(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, destination }));
    }

    return await build((packs, signal, apiPackage) => {
      if (apiPackage && !apiPath) {
        throw new Error('API package publication needs a reserved destination');
      }

      return publishPacks({ packs, paths, signal }, apiPackage ? { source: apiPackage, path: apiPath! } : undefined);
    });
  } finally {
    for (const lock of locks.reverse()) {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

/**
 * Publish pack folders with manifest checks, locks and rollback, without the build runner.
 * @returns Published pack IDs and absolute destination directories.
 * @remarks Updates files in place without renaming pack roots. Snapshots and locks stay in the OS temporary directory. JSON schema validation is separate; use validatePackContent when content checks are required.
 * @throws If manifest checks or publication fail. Failed rollback reports a retained recovery directory.
 */
export async function exportPacks({ packs, paths, signal, environment = process.env }: ExportOptions): Promise<ExportedPack[]> {
  signal?.throwIfAborted();
  checkPackIds(packs, paths);
  paths = Object.fromEntries(Object.entries(paths).map(([id, directory]) => [id, path.resolve(expandExportPath(directory, environment))]));
  checkSources(packs, paths);

  return withExportPaths(paths, publish => publish(packs, signal));
}
