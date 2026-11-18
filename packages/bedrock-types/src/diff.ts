import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildBedrockTypes } from './build.ts';
import { files } from './files.ts';
import { reportsRoot } from './releases.ts';

const exec = promisify(execFile);

export async function diffReleases(from: string, to: string) {
  const base = await buildBedrockTypes(from);
  const candidate = await buildBedrockTypes(to);
  const [before, after] = await Promise.all([files(base.outputPath), files(candidate.outputPath)]);
  const diff = {
    from,
    to,
    added: Object.keys(after).filter(name => !Object.hasOwn(before, name)),
    removed: Object.keys(before).filter(name => !Object.hasOwn(after, name)),
    changed: Object.keys(after).filter(name => Object.hasOwn(before, name) && before[name] !== after[name]),
  };
  const args = ['-c', 'core.safecrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--',
    from + '/dist', to + '/dist'];
  const patch = await exec('git', args, { cwd: reportsRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    .then(result => result.stdout, (error: Error & { code?: number; stdout?: string }) => {
      if (error.code === 1) {
        return error.stdout ?? '';
      }

      throw error;
    });
  const directory = path.join(reportsRoot, to);

  await writeFile(path.join(directory, 'dist.patch'), patch);
  await writeFile(path.join(directory, 'dist-diff.json'), JSON.stringify(diff, null, 2) + '\n');
  console.info(`${from} → ${to}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`);

  return diff;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);

  if (!from || !to || from === to) {
    throw new Error('Usage: node src/diff.ts <earlier version> <candidate version>');
  }

  await diffReleases(from, to);
}
