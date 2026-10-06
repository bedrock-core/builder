import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { inspectPack } from './packs.ts';
import { validatePackManifests } from './manifest.ts';

export interface DeploymentSettings {
  path?: string;
  channel?: 'retail' | 'preview';
}

export interface DeployedPack {
  id: string;
  uuid: string;
  path: string;
}

export interface DeploymentOptions {
  packs: Record<string, string>;
  root: string;
  signal?: AbortSignal;
}

/** Resolve the modern Windows Minecraft data directory, or an explicit project-relative path. */
export function resolveDeploymentRoot(project: string, settings: DeploymentSettings): string {
  if (settings.path) {
    return path.resolve(project, settings.path);
  }

  if (process.platform !== 'win32' || !process.env.APPDATA) {
    throw new Error('Set deploy.path to the Minecraft com.mojang directory on this platform');
  }

  const installation = settings.channel === 'preview' ? 'Minecraft Bedrock Preview' : 'Minecraft Bedrock';

  return path.join(process.env.APPDATA, installation, 'users', 'shared', 'games', 'com.mojang');
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
    throw new Error(`Deployment requires a real directory without symlink ancestors: ${directory}`);
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

async function inspectSource(directory: string): Promise<void> {
  await assertDirectory(directory);

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Deployment source contains a symlink: ${path.join(directory, entry.name)}`);
    }

    if (entry.isDirectory()) {
      await inspectSource(path.join(directory, entry.name));
    }
  }
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);

  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Publish packs independently of the build runner. */
export async function deployPacks(options: DeploymentOptions): Promise<DeployedPack[]> {
  return withDeployment(options, async () => {});
}

/** Keep deployment backups until the caller's local publication also succeeds. */
export async function withDeployment(
  { packs, root, signal }: DeploymentOptions,
  publishLocal: () => Promise<void>,
): Promise<DeployedPack[]> {
  root = path.resolve(root);
  await validatePackManifests(packs);
  const jobs: (DeployedPack & { source: string; candidate?: string; backup?: string; installed: boolean })[] = [];

  for (const [id, directory] of Object.entries(packs)) {
    const source = path.resolve(directory);

    if (overlaps(root, source) || overlaps(source, root)) {
      throw new Error('Deployment root and source packs must be separate directories');
    }

    await inspectSource(source);
    const pack = await inspectPack(id, source);

    if (!pack.defaultDeploymentFolder) {
      throw new Error(`Pack ${id} has no development deployment destination for its manifest modules`);
    }

    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')) as { header: { uuid: string } };
    const uuid = manifest.header.uuid.toLowerCase();

    jobs.push({ id, uuid, source, path: path.join(root, pack.defaultDeploymentFolder, uuid), installed: false });
  }

  signal?.throwIfAborted();
  await ensureDirectory(root);
  const lock = path.join(root, '.bedrock-core-builder-lock');

  await mkdir(lock);
  let workspace: string | undefined;
  let preserveBackup = false;

  try {
    workspace = await mkdtemp(path.join(root, '.bedrock-core-builder-'));

    for (const [index, job] of jobs.entries()) {
      signal?.throwIfAborted();
      await ensureDirectory(path.dirname(job.path));

      if (await exists(job.path)) {
        await assertDirectory(job.path);
        const existing = JSON.parse(await readFile(path.join(job.path, 'manifest.json'), 'utf8')) as { header?: { uuid?: string } };

        if (existing.header?.uuid?.toLowerCase() !== job.uuid) {
          throw new Error(`Deployment destination belongs to a different pack: ${job.path}`);
        }
      }

      job.candidate = path.join(workspace, `candidate-${index}`);
      await cp(job.source, job.candidate, { recursive: true });
    }

    for (const [index, job] of jobs.entries()) {
      signal?.throwIfAborted();

      if (await exists(job.path)) {
        job.backup = path.join(workspace, `backup-${index}`);
        await rename(job.path, job.backup);
      }

      await rename(job.candidate!, job.path);
      job.installed = true;
    }

    signal?.throwIfAborted();
    await publishLocal();

    return jobs.map(({ id, uuid, path }) => ({ id, uuid, path }));
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    for (const job of [...jobs].reverse()) {
      try {
        if (job.installed) {
          await rm(job.path, { recursive: true, force: true });
        }

        if (job.backup && await exists(job.backup)) {
          await rename(job.backup, job.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length) {
      preserveBackup = true;
      throw new AggregateError([error, ...rollbackErrors], `Deployment rollback failed; backups retained at ${workspace}`, { cause: error });
    }

    throw error;
  } finally {
    if (workspace && !preserveBackup) {
      await rm(workspace, { recursive: true, force: true });
    }

    await rm(lock, { recursive: true, force: true });
  }
}
