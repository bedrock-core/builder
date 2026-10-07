import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yarn } from './yarn.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { workspaces: string[] };
const directory = path.join(root, '.bedrock-core/release/tarballs');
const packages: { name: string; version: string; file: string; workspace: string }[] = [];

await mkdir(directory, { recursive: true });

for (const workspace of [...metadata.workspaces, '.']) {
  const pkg = JSON.parse(await readFile(path.join(root, workspace, 'package.json'), 'utf8')) as { name: string; version: string };
  const file = path.join(directory, `${pkg.name.split('/')[1]}-${pkg.version}.tgz`);

  yarn(['workspace', pkg.name, 'pack', '--out', file], root);

  packages.push({ name: pkg.name, version: pkg.version, file: path.basename(file), workspace });
}

await writeFile(path.join(directory, 'index.json'), `${JSON.stringify(packages, null, 2)}\n`);
console.log(`@bedrock-core/builder: packed ${packages.length} release packages`);
