import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { files } from '../../bedrock-types/src/files.ts';
import { buildAssetMaps } from './build.ts';
import { releaseOutput } from './releases.ts';

const exec = promisify(execFile);

export async function writeDistDiff(from: string, to: string, before = releaseOutput(from), after = releaseOutput(to)) {
  const [left, right] = await Promise.all([files(before), files(after)]);
  const diff = {
    from, to,
    added: Object.keys(right).filter(file => !Object.hasOwn(left, file)),
    removed: Object.keys(left).filter(file => !Object.hasOwn(right, file)),
    changed: Object.keys(right).filter(file => Object.hasOwn(left, file) && left[file] !== right[file]),
  };
  const output = path.dirname(after);
  const args = ['-c', 'core.safecrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--',
    path.relative(output, before), path.relative(output, after)];
  const patch = await exec('git', args, { cwd: output, maxBuffer: 128 * 1024 * 1024, windowsHide: true })
    .then(result => result.stdout, (error: Error & { code?: number; stdout?: string }) => {
      if (error.code === 1) {
        return error.stdout ?? '';
      }

      throw error;
    });

  await Promise.all([
    writeFile(path.join(output, 'dist-diff.json'), JSON.stringify(diff, null, 2) + '\n'),
    writeFile(path.join(output, 'dist.patch'), patch),
  ]);

  return diff;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to, ...args] = process.argv.slice(2);

  if (!from || !to || from === to || args.some(value => value !== '--offline')) {
    throw new Error('Usage: node src/diff.ts <version> <version> [--offline]');
  }

  const offline = args.includes('--offline');

  await buildAssetMaps({ version: from, offline });
  await buildAssetMaps({ version: to, offline });
  console.info(JSON.stringify(await writeDistDiff(from, to)));
}
