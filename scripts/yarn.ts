import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Run the invoking Yarn release without a shell or global package-manager dependency. */
export function yarn(args: string[], cwd: string, env = process.env): void {
  const entry = process.env.COREPACK_ROOT
    ? path.join(process.env.COREPACK_ROOT, 'dist/yarn.js')
    : process.env.npm_execpath;

  if (!entry) {
    throw new Error('Run this release script through yarn');
  }

  const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, stdio: 'inherit' });

  if (result.status !== 0) {
    throw new Error(`yarn ${args.join(' ')} failed`, { cause: result.error });
  }
}
