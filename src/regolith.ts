import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { BuildContext } from './contract.d.ts';
import type { NodePluginDefinition, Settings } from './config.ts';
import { withSourceWrites } from './source-writes.ts';

interface NodeFilterOptions extends NodePluginDefinition {
  settings?: Settings;
  arguments?: string[];
}

interface Session {
  directory: string;
  dataSource: string;
  baseline?: string;
  persist: boolean;
}

const sessions = new WeakMap<BuildContext, Map<string, Session>>();
const roles = ['BP', 'RP'] as const;

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
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

async function inspect(directory: string): Promise<void> {
  const info = await lstat(directory);

  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(await realpath(directory), directory) !== '') {
    throw new Error('Node filter workspace requires real directories without symlink ancestors: ' + directory);
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error('Node filter workspace contains a symlink: ' + file);
    }

    if (entry.isDirectory()) {
      await inspect(file);
    }
  }
}

async function packPaths(context: BuildContext, options: NodeFilterOptions): Promise<Partial<Record<'BP' | 'RP', string>>> {
  const selected: Partial<Record<'BP' | 'RP', string>> = options.folders ? { ...options.folders } : {};

  if (!options.folders) {
    for (const id of Object.keys(context.packs)) {
      const pack = await context.inspectPack(id);
      const role = pack.kind === 'behavior' ? 'BP' : pack.kind === 'resource' ? 'RP' : undefined;

      if (!role) {
        continue;
      }

      if (selected[role]) {
        throw new Error('Node filters need an explicit folders.' + role + ' mapping when more than one pack has that type');
      }

      selected[role] = id;
    }
  }

  if (!options.folders && !Object.keys(selected).length) {
    throw new Error('Node filter needs at least one BP or RP pack mapping');
  }

  const paths: Partial<Record<'BP' | 'RP', string>> = {};

  for (const role of roles) {
    const id = selected[role];

    if (id === undefined) {
      continue;
    }

    if (!Object.hasOwn(context.packs, id)) {
      throw new Error('Node filter pack is not configured: ' + id);
    }

    const pack = await context.inspectPack(id);
    const expected = role === 'BP' ? 'behavior' : 'resource';

    if (pack.kind !== expected) {
      throw new Error(`Node filter folders.${role} requires a ${expected} pack: ${id}`);
    }

    const directory = path.resolve(context.packs[id]!);

    if (!contains(context.stagedRoot, directory) || path.relative(context.stagedRoot, directory) === ''
      || contains(context.projectRoot, directory)) {
      throw new Error('Node filters require pack directories inside a separate staged project');
    }

    if (Object.values(paths).some(other => path.relative(other, directory) === '')) {
      throw new Error('Node filter BP and RP must select different packs');
    }

    await inspect(directory);
    paths[role] = directory;
  }

  return paths;
}

async function dataFingerprint(root: string): Promise<string> {
  await inspect(root);
  const hash = createHash('sha256');

  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);

      hash.update(JSON.stringify([path.relative(root, file), entry.isDirectory()]));

      if (entry.isDirectory()) {
        await visit(file);
      } else {
        hash.update(createHash('sha256').update(await readFile(file)).digest());
      }
    }
  }

  await visit(root);

  return hash.digest('hex');
}

async function sessionFor(context: BuildContext, options: NodeFilterOptions): Promise<Session> {
  if (options.persistData && options.dataPath === undefined) {
    throw new Error('Persistent Node data requires an explicit dataPath');
  }

  const source = path.resolve(context.projectRoot, options.dataPath ?? './data');
  const key = process.platform === 'win32' ? source.toLowerCase() : source;
  const current = sessions.get(context)?.get(key);

  if (!contains(context.projectRoot, source) || source === context.projectRoot) {
    throw new Error('Node filter dataPath must be a dedicated directory inside the project');
  }

  const stagedSource = path.join(context.stagedRoot, path.relative(context.projectRoot, source));
  const hasSource = await exists(stagedSource);

  if (!hasSource && options.dataPath !== undefined) {
    throw new Error('Node filter dataPath does not exist: ' + source);
  }

  if (hasSource) {
    await inspect(stagedSource);
  }

  context.registerDependency(source);

  if (current) {
    if (options.persistData && !current.persist) {
      current.persist = true;
      current.baseline = await dataFingerprint(stagedSource);
    }

    await inspect(current.directory);

    return current;
  }

  const directory = await mkdtemp(path.join(context.generatedDir, 'regolith-node-'));
  const data = path.join(directory, 'data');

  if (hasSource) {
    await cp(stagedSource, data, { recursive: true });
  } else {
    await mkdir(data);
  }

  const session: Session = { directory, dataSource: source, persist: options.persistData === true };

  if (session.persist) {
    session.baseline = await dataFingerprint(stagedSource);
  }

  const entries = sessions.get(context) ?? new Map<string, Session>();

  entries.set(key, session);
  sessions.set(context, entries);

  return session;
}

async function execute(context: BuildContext, options: NodeFilterOptions, directory: string, script: string, filterDir: string): Promise<void> {
  const settings = options.settings && Object.keys(options.settings).length ? [JSON.stringify(options.settings)] : [];
  const args = [...options.nodeArguments ?? [], script, ...settings, ...options.arguments ?? []];

  context.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env: {
        ...process.env, ROOT_DIR: context.projectRoot, FILTER_DIR: filterDir,
        ...(context.pack ? { PACK_ID: context.pack.id, PACK_TYPE: context.pack.kind } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    let failure: Error | undefined;

    const abort = () => {
      child.kill('SIGKILL');
    };

    stdout.on('line', line => context.logger.info?.(line));
    stderr.on('line', line => context.logger.error?.(line));
    child.on('error', (error) => {
      failure = error;
    });
    context.signal?.addEventListener('abort', abort, { once: true });

    if (context.signal?.aborted) {
      abort();
    }

    child.on('close', (code, signal) => {
      context.signal?.removeEventListener('abort', abort);
      stdout.close();
      stderr.close();

      if (context.signal?.aborted) {
        reject(context.signal.reason);
      } else if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(new Error('Node filter failed (' + (signal ?? 'exit code ' + code) + '): ' + script));
      } else {
        resolve();
      }
    });
  });
}

/** Run a standalone Regolith Node script against conventional staged BP, RP and data folders. */
export async function runNodeFilter(context: BuildContext, options: NodeFilterOptions, sharedContext = context): Promise<void> {
  context.signal?.throwIfAborted();
  const filterDir = await realpath(path.resolve(context.projectRoot, options.filterDir ?? '.'));
  const script = await realpath(path.resolve(filterDir, options.script));

  if (!(await lstat(script)).isFile()) {
    throw new Error('Node filter script must be a file: ' + script);
  }

  context.registerDependency(script);
  context.registerDependency(filterDir);
  const packs = await packPaths(context, options);
  const session = await sessionFor(sharedContext, options);

  for (const role of roles) {
    const directory = path.join(session.directory, role);

    await rm(directory, { recursive: true, force: true });

    if (packs[role]) {
      await cp(packs[role]!, directory, { recursive: true });
    } else {
      await mkdir(directory);
    }
  }

  await execute(context, options, session.directory, script, filterDir);
  context.signal?.throwIfAborted();
  await inspect(session.directory);

  for (const role of roles) {
    const directory = path.join(session.directory, role);

    if (!packs[role] && await exists(directory) && (await readdir(directory)).length) {
      throw new Error('Node filter wrote to ' + role + ' without a configured pack mapping');
    }

    if (packs[role]) {
      await inspect(directory);
    }
  }

  for (const role of roles) {
    if (packs[role]) {
      await rm(packs[role]!, { recursive: true, force: true });
      await cp(path.join(session.directory, role), packs[role]!, { recursive: true });
    }
  }
}

/** Publish opted-in data with pack publication, restoring authored data if publication fails. */
export async function publishNodeData<T>(context: BuildContext, publish: () => Promise<T>): Promise<T> {
  const all = [...sessions.get(context)?.values() ?? []];
  const selected = all.filter(session => session.persist);

  if (!selected.length) {
    return publish();
  }

  const jobs: { source: string; candidate: string; backup?: string; installed: boolean; fingerprint: string; session: Session }[] = [];
  const locks: string[] = [];
  let retainBackups = false;

  for (const session of selected) {
    const source = session.dataSource;
    const parts = path.relative(context.projectRoot, source).split(path.sep);
    const roots = [...Object.values(context.allPacks ?? context.packs).map(directory => path.join(context.projectRoot, path.relative(context.stagedRoot, directory))), ...Object.values(context.outputPaths)];

    if (!contains(context.projectRoot, source) || source === context.projectRoot
      || parts.some(part => ['.git', 'node_modules', '.bedrock-core'].includes(part) || part.includes('.builder-'))
      || roots.some(root => contains(root, source) || contains(source, root))) {
      throw new Error('Persistent Node data must use a dedicated source directory outside packs, exports and project internals: ' + source);
    }

    if (all.some(other => other !== session && (contains(source, other.dataSource) || contains(other.dataSource, source)))) {
      throw new Error('Persistent Node data sources must not overlap: ' + source);
    }
  }

  try {
    for (const session of selected.sort((a, b) => a.dataSource.localeCompare(b.dataSource))) {
      context.signal?.throwIfAborted();
      const source = session.dataSource;
      const lock = source + '.builder-data-lock';

      await mkdir(lock);
      locks.push(lock);

      if (await dataFingerprint(source) !== session.baseline) {
        throw new Error('Node data changed during the build: ' + source);
      }

      const job = { source, candidate: source + '.builder-data-' + randomUUID(), installed: false, fingerprint: '', session };

      jobs.push(job);
      await cp(path.join(session.directory, 'data'), job.candidate, { recursive: true });
      job.fingerprint = await dataFingerprint(job.candidate);
    }

    return await withSourceWrites(context.projectRoot, jobs.map(job => ({
      directory: job.source,
      async matches() {
        try {
          return await dataFingerprint(job.source) === (job.installed ? job.fingerprint : job.session.baseline);
        } catch { return false; }
      },
    })), async () => {
      try {
        for (const job of jobs) {
          context.signal?.throwIfAborted();

          if (await dataFingerprint(job.source) !== job.session.baseline) {
            throw new Error('Node data changed during the build: ' + job.source);
          }

          job.backup = job.source + '.builder-data-backup-' + randomUUID();
          await rename(job.source, job.backup);
          await rename(job.candidate, job.source);
          job.installed = true;
        }

        context.signal?.throwIfAborted();
        const result = await publish();

        return result;
      } catch (error) {
        const failures: unknown[] = [];

        for (const job of [...jobs].reverse()) {
          try {
            if (job.installed) {
              if (await dataFingerprint(job.source) !== job.fingerprint) {
                throw new Error('Node data was edited during publication; preserving the edited source: ' + job.source, { cause: error });
              }

              await rm(job.source, { recursive: true, force: true });
              job.installed = false;
            }

            if (job.backup && await exists(job.backup)) {
              await rename(job.backup, job.source);
              job.backup = undefined;
            }
          } catch (failure) {
            failures.push(failure);
          }
        }

        if (failures.length) {
          retainBackups = true;
          throw new AggregateError([error, ...failures], 'Node data rollback failed; backups retained at ' + jobs.flatMap(job => job.backup ?? []).join(', '), { cause: error });
        }

        throw error;
      }
    });
  } finally {
    const cleanup = [...jobs.flatMap(job => [job.candidate, ...(job.backup && !retainBackups ? [job.backup] : [])]), ...locks];

    for (const file of cleanup) {
      try {
        await rm(file, { recursive: true, force: true });
      } catch {
        context.logger.warn?.('Node data cleanup failed: ' + file);
      }
    }
  }
}
