import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { BuildContext } from './contract.d.ts';
import type { NodePluginDefinition, Settings } from './config.ts';

interface NodeFilterOptions extends NodePluginDefinition {
  settings?: Settings;
  arguments?: string[];
}

interface Session {
  directory: string;
  dataSource: string;
}

const sessions = new WeakMap<BuildContext, Session>();
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
  const selected: Partial<Record<'BP' | 'RP', string>> = options.packs ? { ...options.packs } : {};

  if (!options.packs) {
    for (const id of Object.keys(context.packs)) {
      const pack = await context.inspectPack(id);
      const role = pack.kind === 'behavior' ? 'BP' : pack.kind === 'resource' ? 'RP' : undefined;

      if (!role) {
        continue;
      }

      if (selected[role]) {
        throw new Error('Node filters need an explicit packs.' + role + ' mapping when more than one pack has that type');
      }

      selected[role] = id;
    }
  }

  if (!Object.keys(selected).length) {
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

async function sessionFor(context: BuildContext, options: NodeFilterOptions): Promise<Session> {
  const source = path.resolve(context.projectRoot, options.dataPath ?? './data');
  const current = sessions.get(context);

  if (current) {
    if (options.dataPath !== undefined && path.relative(current.dataSource, source) !== '') {
      throw new Error('Node filter steps in one build must share the same dataPath');
    }

    await inspect(current.directory);

    return current;
  }

  if (!contains(context.projectRoot, source)) {
    throw new Error('Node filter dataPath must be inside the project');
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
  const directory = await mkdtemp(path.join(context.generatedDir, 'regolith-node-'));
  const data = path.join(directory, 'data');

  if (hasSource) {
    await cp(stagedSource, data, { recursive: true });
  } else {
    await mkdir(data);
  }

  const session = { directory, dataSource: source };

  sessions.set(context, session);

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
