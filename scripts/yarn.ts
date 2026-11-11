import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Run the invoking Yarn release without a shell or global package-manager dependency. */
export function yarn(args: string[], cwd: string, env = process.env): void {
  runYarn(args, cwd, env, false);
}

/** Read structured command output from the invoking Yarn release. */
export function yarnOutput(args: string[], cwd: string, env = process.env): string {
  return runYarn(args, cwd, env, true);
}

function runYarn(args: string[], cwd: string, env: NodeJS.ProcessEnv, capture: boolean): string {
  const entry = process.env.COREPACK_ROOT
    ? path.join(process.env.COREPACK_ROOT, 'dist/yarn.js')
    : process.env.npm_execpath;

  if (!entry) {
    throw new Error('Run this release script through yarn');
  }

  const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });

  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr ?? '');
    }

    throw new Error(`yarn ${args.join(' ')} failed`, { cause: result.error });
  }

  return result.stdout ?? '';
}
