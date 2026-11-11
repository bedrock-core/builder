import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTgz } from '../packages/generator/src/tar.ts';
import { acceptanceArchives, acceptanceYarnConfig, archiveIntegrity, type AcceptanceArchiveIndex } from './acceptance-archives.ts';
import { yarn, yarnOutput } from './yarn.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

assert.ok(args.length === 4 && args[0] === '--ui' && args[2] === '--apps', 'Usage: yarn prepare:acceptance --ui <checkout> --apps <checkout>');
const parent = path.join(repository, '.bedrock-core/acceptance');

await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, 'candidate-'));
const archives = path.join(root, 'archives');
const index: AcceptanceArchiveIndex = { sources: [], packages: [] };

await mkdir(archives);

async function snapshot(source: string, name: 'ui' | 'apps'): Promise<string> {
  source = path.resolve(source);
  const git = ['-c', `safe.directory=${source}`, '-C', source];
  const commit = execFileSync('git', [...git, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bytes = execFileSync('git', [...git, 'archive', '--format=tar.gz', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 });
  const directory = path.join(root, name);

  for (const [file, contents] of extractTgz(bytes)) {
    const destination = path.resolve(directory, file);

    assert.ok(destination.startsWith(directory + path.sep), 'Source archive path escapes its checkout');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }

  index.sources.push({ repository: 'bedrock-core/' + name, commit });
  const configFile = path.join(directory, '.changeset/config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));

  await writeFile(configFile, JSON.stringify({ ...config, changelog: false, commit: false }, null, 2) + '\n');
  const pending = (await readdir(path.dirname(configFile))).some(file => file.endsWith('.md') && file !== 'README.md');

  if (pending) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('@changesets/cli/bin.js')), 'version'], { cwd: directory, stdio: 'inherit' });
  }

  console.log(`@bedrock-core/builder: prepared ${name} candidate from ${commit}`);

  return directory;
}

async function install(directory: string, resolutions: Record<string, string>): Promise<void> {
  const file = path.join(directory, 'package.json');
  const original = await readFile(file, 'utf8');
  const manifest = JSON.parse(original);

  await writeFile(file, JSON.stringify({ ...manifest, resolutions: { ...manifest.resolutions, ...resolutions } }, null, 2) + '\n');

  try {
    yarn(['install', '--no-immutable'], directory);
  } finally {
    // Candidate tarballs retain their authored public dependency declarations.
    await writeFile(file, original);
  }
}

async function pack(directory: string, only?: string): Promise<void> {
  const workspaces = yarnOutput(['workspaces', 'list', '--json'], directory).trim().split('\n').map(line => JSON.parse(line) as { name: string; location: string });

  for (const workspace of workspaces) {
    if (only && workspace.name !== only) {
      continue;
    }

    const manifest = JSON.parse(await readFile(path.join(directory, workspace.location, 'package.json'), 'utf8')) as { name: string; version: string; private?: boolean };

    if (manifest.private) {
      continue;
    }

    const file = manifest.name.slice('@bedrock-core/'.length) + '.tgz';

    yarn(['workspace', manifest.name, 'pack', '--out', path.join(archives, file)], directory);
    const bytes = await readFile(path.join(archives, file));
    const packaged = JSON.parse(extractTgz(bytes).get('package/package.json')!.toString()) as Record<string, Record<string, string> | undefined>;

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'resolutions']) {
      assert.ok(Object.values(packaged[field] ?? {}).every(value => !/^(file|portal|workspace):/.test(value)), 'Candidate archive has local dependency declarations: ' + manifest.name);
    }

    index.packages.push({ name: manifest.name, version: manifest.version, file, integrity: archiveIntegrity(bytes) });
  }
}

yarn(['pack-release'], repository);
const builderDirectory = path.join(repository, '.bedrock-core/release/tarballs');
const builderPackages = JSON.parse(await readFile(path.join(builderDirectory, 'index.json'), 'utf8')) as { name: string; file: string }[];
const builderResolutions = Object.fromEntries(builderPackages.filter(pkg => pkg.name.startsWith('@bedrock-core/builder')).map(pkg => [pkg.name, `file:${path.join(builderDirectory, pkg.file).replaceAll('\\', '/')}`]));
const ui = await snapshot(args[1], 'ui');

await install(ui, builderResolutions);
await pack(ui);
const indexFile = path.join(archives, 'index.json');

await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
const uiArchives = await acceptanceArchives(indexFile);
const apps = await snapshot(args[3], 'apps');

await install(apps, { ...builderResolutions, ...uiArchives.resolutions });
await pack(apps, '@bedrock-core/guides');
await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
const candidates = await acceptanceArchives(indexFile);
const dependencies = path.join(root, 'dependencies');
const fixture = JSON.parse(await readFile(path.join(repository, 'fixtures/acceptance/package.json'), 'utf8'));

await mkdir(dependencies);
await writeFile(path.join(dependencies, 'package.json'), JSON.stringify({
  ...fixture, packageManager: 'yarn@4.16.0',
  resolutions: { ...builderResolutions, ...candidates.resolutions },
}, null, 2) + '\n');
await writeFile(path.join(dependencies, '.yarnrc.yml'), acceptanceYarnConfig);
await writeFile(path.join(dependencies, 'yarn.lock'), '');
yarn(['install', '--no-immutable'], dependencies);

const environment = {
  BUILDER_ACCEPTANCE_DEPENDENCY_ROOT: dependencies,
  BUILDER_ACCEPTANCE_ARCHIVES: indexFile,
};

if (process.env.GITHUB_ENV) {
  await appendFile(process.env.GITHUB_ENV, Object.entries(environment).map(([name, value]) => `${name}=${value}\n`).join(''));
}

await writeFile(path.join(root, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
console.log('@bedrock-core/builder: acceptance candidates prepared: ' + path.join(root, 'environment.json'));
