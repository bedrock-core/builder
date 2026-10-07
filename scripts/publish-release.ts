import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yarn } from './yarn.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.bedrock-core/release/tarballs');
const packages = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')) as { name: string; version: string; file: string; workspace: string }[];
const verification = JSON.parse(await readFile(path.join(directory, 'verified.json'), 'utf8')) as { integrities: Record<string, string> };
const dryRun = process.argv.includes('--dry-run');

for (const pkg of packages) {
  const registry = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`;
  const existing = await fetch(registry);
  const integrity = `sha512-${createHash('sha512').update(await readFile(path.join(directory, pkg.file))).digest('base64')}`;

  if (verification.integrities[pkg.name] !== integrity) {
    throw new Error(`Run yarn test:packages for the current ${pkg.name} tarball before publication`);
  }

  const candidate = await mkdtemp(path.join(tmpdir(), 'builder-publish-check-'));

  try {
    const file = path.join(candidate, pkg.file);

    yarn(['workspace', pkg.name, 'pack', '--out', file], root);
    const current = `sha512-${createHash('sha512').update(await readFile(file)).digest('base64')}`;

    if (current !== integrity) {
      throw new Error(`Package files changed since verification: ${pkg.name}`);
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }

  if (existing.ok) {
    const published = await existing.json() as { dist: { integrity: string } };

    if (published.dist.integrity !== integrity) {
      throw new Error(`Registry version ${pkg.name}@${pkg.version} differs from the checked tarball`);
    }

    console.log(`@bedrock-core/builder: ${pkg.name}@${pkg.version} is already published`);
    continue;
  }

  if (existing.status !== 404) {
    throw new Error(`Cannot check ${pkg.name}: registry HTTP ${existing.status}`);
  }

  if (dryRun) {
    console.log(`@bedrock-core/builder: checked ${pkg.name}@${pkg.version} for publication (dry run)`);
    continue;
  }

  yarn(['workspace', pkg.name, 'npm', 'publish', '--access', 'public', '--tag', 'next'], root);
  const verified = await fetch(registry);

  if (!verified.ok) {
    throw new Error(`Cannot verify published ${pkg.name}@${pkg.version}: HTTP ${verified.status}`);
  }

  const published = await verified.json() as { dist: { integrity: string } };

  if (published.dist.integrity !== integrity) {
    throw new Error(`Published ${pkg.name} does not match the checked release tarball`);
  }

  console.log(`@bedrock-core/builder: published and verified ${pkg.name}@${pkg.version}`);
}
