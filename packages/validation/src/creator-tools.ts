import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ContentDiagnostic, ContentPack } from './index.ts';

export interface CreatorToolsValidationOptions {
  mode: 'warn' | 'strict';
  /** Project directory from which to resolve @minecraft/creator-tools. */
  projectRoot?: string;
}

export interface CreatorToolsDiagnostic extends ContentDiagnostic {
  kind: 'creator-tools';
  severity: 'error' | 'warning' | 'recommendation';
  rule: string;
}

export interface CreatorToolsResult {
  version?: string;
  /** Rules that ran on the assembled pack set. */
  rules: string[];
  diagnostics: CreatorToolsDiagnostic[];
}

interface ValidatorItem {
  type: string;
  generatorId?: string;
  path?: string;
  message?: string;
  data?: unknown;
}

const exec = promisify(execFile);
const packageName = '@minecraft/creator-tools';
const timeout = 300000;

function creatorTools(project: string): string {
  try {
    return createRequire(path.join(project, 'package.json')).resolve(packageName + '/package.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      throw error;
    }

    throw new Error('Install @minecraft/creator-tools in the project to enable its validation.', { cause: error });
  }
}

function severity(type: string): CreatorToolsDiagnostic['severity'] | undefined {
  switch (type) {
    case 'error':
    case 'internalProcessingError':
    case 'testFail':
      return 'error';
    case 'warning':
      return 'warning';
    case 'recommendation':
      return 'recommendation';
  }
}

/** Creator Tools counts nested textures as pack icons. Confirm the root icon for a duplicate finding. */
async function validRootPackIcon(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  const icons = entries.filter(entry => entry.isFile() && entry.name.includes('pack_icon') && entry.name.endsWith('.png'));

  if (icons.length !== 1 || icons[0].name !== 'pack_icon.png') {
    return false;
  }

  await using icon = await open(path.join(directory, 'pack_icon.png'));
  const header = Buffer.alloc(33);
  const { bytesRead } = await icon.read(header);

  if (bytesRead !== header.length || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') {
    return false;
  }

  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);

  return width === height && width >= 2 && width <= 256 && (width & (width - 1)) === 0;
}

/** Check the installed release SDK when the CLI reports a beta version from its own catalog. */
async function matchesInstalledBeta(message: string | undefined, project: string, targetVersion: string | undefined): Promise<boolean> {
  const issue = /^For (@minecraft\/[\w-]+), using an out of date beta version (\d+\.\d+\.\d+-beta) compared to the current version$/.exec(message ?? '');

  if (!issue || !targetVersion) {
    return false;
  }

  const [, moduleName, manifestVersion] = issue;

  try {
    const file = createRequire(path.join(project, 'package.json')).resolve(moduleName + '/package.json');
    const sdk = JSON.parse(await readFile(file, 'utf8')) as { name: string; version: string };
    const release = /^(\d+\.\d+\.\d+-beta)\.(\d+\.\d+\.\d+)-(?:stable|preview\.(\d+))$/.exec(sdk.version);

    return sdk.name === moduleName && release !== null && release[1] === manifestVersion
      && (release[2] === targetVersion || (release[3] !== undefined && release[2] + '.' + release[3] === targetVersion));
  } catch {
    return false;
  }
}

/** Run Mojang's CLI on the complete behavior/resource pack set before export. */
export async function validateWithCreatorTools(
  packs: readonly ContentPack[],
  options: CreatorToolsValidationOptions,
  signal?: AbortSignal,
  targetVersion?: string,
): Promise<CreatorToolsResult> {
  const selected = packs.filter(pack => pack.kind !== 'other');

  if (!selected.length) {
    return { rules: [], diagnostics: [] };
  }

  const size = 64 * 1024 * 1024;
  let version: string | undefined;
  let workspace: string | undefined;

  try {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const manifestFile = creatorTools(projectRoot);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { name: string; version: string; bin?: { mct?: string } };
    const directory = path.dirname(manifestFile);
    const executable = path.resolve(directory, manifest.bin?.mct ?? '');
    const relative = path.relative(directory, executable);

    if (manifest.name !== packageName || !relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('The installed Creator Tools package has no valid mct entry point.');
    }

    version = manifest.version;
    workspace = await mkdtemp(path.join(tmpdir(), 'bedrock-creator-tools-'));
    const project = path.join(workspace, 'project');
    const folders = new Map<string, ContentPack>();

    for (const [index, pack] of selected.entries()) {
      signal?.throwIfAborted();
      const folder = `${pack.kind}_packs/pack-${index}`;
      const destination = path.join(project, folder);

      await mkdir(path.dirname(destination), { recursive: true });
      await cp(pack.path, destination, {
        recursive: true,
        verbatimSymlinks: true,
        async filter(source) {
          signal?.throwIfAborted();

          if ((await lstat(source)).isSymbolicLink()) {
            throw new Error('Creator Tools cannot validate pack links: ' + pack.id);
          }

          return true;
        },
      });
      folders.set(folder, pack);
    }

    const args = [executable, 'validate', 'main', '-i', project, '-o', path.join(workspace, 'reports'), '--single', '--offline', '--json', '--force'];
    const childOptions = {
      cwd: workspace,
      env: { ...process.env, MCTOOLS_DATA_DIR: path.join(workspace, 'data') },
      maxBuffer: size,
      signal,
      timeout,
      windowsHide: true,
    };
    const stdout = await exec(process.execPath, args, childOptions).then(result => result.stdout, (error: Error & { code?: number; stdout?: string }) => {
      // Completed checks can return nonzero alongside their structured findings.
      if (typeof error.code === 'number' && [1, 3, 4, 5].includes(error.code) && error.stdout) {
        return error.stdout;
      }

      throw error;
    });
    const report = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as { command?: string; projects?: { items?: ValidatorItem[] }[] };

    if (report.command !== 'validate' || !report.projects?.length || report.projects.some(project => !Array.isArray(project.items))) {
      throw new Error('Creator Tools returned no validation project.');
    }

    const items = report.projects.flatMap(project => project.items!);
    const detailed = new Set(items.filter(item => item.type === 'error' || item.type === 'internalProcessingError').map(item => item.generatorId));
    const rules = new Set<string>();
    const diagnostics: CreatorToolsDiagnostic[] = [];

    for (const item of items) {
      if (item.generatorId && item.type !== 'unknown') {
        rules.add(item.generatorId);
      }

      const level = severity(item.type);

      if (!level || (item.type === 'testFail' && detailed.has(item.generatorId))) {
        continue;
      }

      if (item.generatorId === 'CPACKICON' && level === 'error') {
        const duplicate = /^Found multiple pack icon files for (pack-\d+), there should be only one\.$/.exec(item.message ?? '');
        const folder = duplicate && [...folders.keys()].find(folder => path.posix.basename(folder) === duplicate[1]);

        if (folder && await validRootPackIcon(path.join(project, folder))) {
          continue;
        }
      }

      const name = item.path?.replaceAll('\\', '/').replace(/^\/+/, '') ?? '';
      const folder = [...folders.keys()].find(folder => name === folder || name.startsWith(folder + '/'));
      const rule = item.generatorId ?? 'MCT';

      if (rule === 'SCRIPTMODULE' && level === 'error' && folder && name === folder + '/manifest.json'
        && await matchesInstalledBeta(item.message, projectRoot, targetVersion)) {
        continue;
      }

      const detail = typeof item.data === 'string' ? ' — ' + item.data : '';

      diagnostics.push({
        kind: 'creator-tools',
        severity: level,
        rule,
        pack: folder ? folders.get(folder)!.id : 'project',
        file: folder ? name.slice(folder.length + 1) : name,
        pointer: '',
        message: `[${rule}] ${item.message ?? 'Creator Tools validation issue'}${detail}`,
      });
    }

    if (!rules.size && !diagnostics.length) {
      throw new Error('Creator Tools did not run any validation rules.');
    }

    return { version, rules: [...rules].sort(), diagnostics };
  } catch (error) {
    signal?.throwIfAborted();

    // Child-process errors can include the entire command and report output.
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    const detail = failure.killed
      ? `timed out after ${timeout / 1000} seconds`
      : failure.signal
        ? 'process ended with ' + failure.signal
        : failure.code
          ? 'process error ' + failure.code
          : error instanceof SyntaxError ? 'invalid JSON report' : failure.message;

    return {
      version,
      rules: [],
      diagnostics: [{
        kind: 'creator-tools',
        severity: 'error',
        rule: 'MCT',
        pack: 'project',
        file: '',
        pointer: '',
        message: 'Creator Tools validation could not complete: ' + detail,
      }],
    };
  } finally {
    if (workspace && path.dirname(workspace) === path.resolve(tmpdir()) && path.basename(workspace).startsWith('bedrock-creator-tools-')) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
