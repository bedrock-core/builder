import { cp, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readManifest, validatePackManifests } from './manifest.ts';

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

type PublishPacks = (packs: Record<string, string>, signal?: AbortSignal) => Promise<ExportedPack[]>;

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

  return paths;
}

async function inspectSource(directory: string): Promise<void> {
  await assertDirectory(directory);

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Export source contains a symlink: ${path.join(directory, entry.name)}`);
    }

    if (entry.isDirectory()) {
      await inspectSource(path.join(directory, entry.name));
    }
  }
}

async function publishPacks({ packs, paths, signal }: ExportOptions): Promise<ExportedPack[]> {
  checkPackIds(packs, paths);
  await validatePackManifests(packs);
  const jobs: { id: string; path: string; candidate: string; backup?: string; installed: boolean }[] = [];
  let preserveBackups = false;

  try {
    for (const [id, directory] of Object.entries(packs)) {
      signal?.throwIfAborted();
      const source = path.resolve(directory);
      const destination = paths[id]!;

      await inspectSource(source);

      if (await exists(destination)) {
        await assertDirectory(destination);

        if ((await readdir(destination)).length) {
          try {
            await readManifest(id, destination);
          } catch (cause) {
            throw new Error(`Export destination does not identify a pack: ${destination}`, { cause });
          }
        }
      }

      const job = { id, path: destination, candidate: `${destination}.builder-${randomUUID()}`, installed: false };

      jobs.push(job);
      await cp(source, job.candidate, { recursive: true });
    }

    for (const job of jobs) {
      signal?.throwIfAborted();

      if (await exists(job.path)) {
        job.backup = `${job.path}.builder-backup-${randomUUID()}`;
        await rename(job.path, job.backup);
      }

      await rename(job.candidate, job.path);
      job.installed = true;
    }

    signal?.throwIfAborted();

    return jobs.map(({ id, path }) => ({ id, path }));
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    for (const job of [...jobs].reverse()) {
      try {
        if (job.installed) {
          await rm(job.path, { recursive: true, force: true });
        }

        if (job.backup && await exists(job.backup)) {
          await rename(job.backup, job.path);
          job.backup = undefined;
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length) {
      preserveBackups = true;
      const backups = jobs.flatMap(job => job.backup ? [job.backup] : []);

      throw new AggregateError([error, ...rollbackErrors], `Export rollback failed; backups retained at ${backups.join(', ')}`, { cause: error });
    }

    throw error;
  } finally {
    for (const job of jobs) {
      await rm(job.candidate, { recursive: true, force: true });

      if (job.backup && !preserveBackups) {
        await rm(job.backup, { recursive: true, force: true });
      }
    }
  }
}

/**
 * Hold destination locks while the callback prepares and publishes validated packs.
 * @param paths Dedicated nonoverlapping pack destination directories.
 * @param build Callback receiving the guarded publication function.
 * @returns The callback result, with destination locks released on completion.
 * @remarks This API holds locks and provides publication; the callback owns preparation and any additional validation.
 * @throws If a destination is unsafe or already locked, or the callback fails.
 */
export async function withExportPaths<T>(paths: Record<string, string>, build: (publish: PublishPacks) => Promise<T>): Promise<T> {
  paths = Object.fromEntries(Object.entries(paths).map(([id, directory]) => [id, path.resolve(directory)]));
  checkDestinations(paths);
  const locks: string[] = [];

  try {
    for (const destination of Object.values(paths).sort()) {
      await ensureDirectory(path.dirname(destination));

      if (await exists(destination)) {
        await assertDirectory(destination);
      }

      const lock = `${destination}.builder-lock`;

      await mkdir(lock);
      locks.push(lock);
    }

    return await build((packs, signal) => publishPacks({ packs, paths, signal }));
  } finally {
    for (const lock of locks.reverse()) {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

/**
 * Publish pack folders with manifest checks, locks and rollback, without the build runner.
 * @returns Published pack IDs and absolute destination directories.
 * @remarks JSON schema validation is separate. Use validatePackContent before publication when content checks are required.
 * @throws If manifest checks or publication fail; previous exports are retained.
 */
export async function exportPacks({ packs, paths, signal, environment = process.env }: ExportOptions): Promise<ExportedPack[]> {
  signal?.throwIfAborted();
  checkPackIds(packs, paths);
  paths = Object.fromEntries(Object.entries(paths).map(([id, directory]) => [id, path.resolve(expandExportPath(directory, environment))]));
  checkSources(packs, paths);

  return withExportPaths(paths, publish => publish(packs, signal));
}
