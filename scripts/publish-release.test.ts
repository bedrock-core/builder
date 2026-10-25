import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { publishOptions, publishRelease, type ReleasePackage, type PublishServices } from './publish-release.ts';

async function fixture(t: TestContext, version = '0.1.0') {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-publish-test-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.bedrock-core/release/tarballs');
  const packages: ReleasePackage[] = [
    { name: '@bedrock-core/builder', version, file: 'builder.tgz', workspace: '.' },
    { name: '@bedrock-core/cli', version: '0.12.0', file: 'cli.tgz', workspace: 'packages/cli' },
    { name: '@bedrock-core/builder-plugin', version, file: 'plugin.tgz', workspace: 'packages/plugin' },
  ];

  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, '.changeset'));
  const integrities: Record<string, string> = {};

  for (const pkg of packages) {
    await mkdir(path.join(root, pkg.workspace), { recursive: true });
    await writeFile(path.join(root, pkg.workspace, 'package.json'), JSON.stringify({
      name: pkg.name, version: pkg.version,
      dependencies: pkg.workspace === '.' ? { '@bedrock-core/builder-plugin': 'workspace:*' } : {},
    }));
    const bytes = Buffer.from(pkg.name + '@' + pkg.version);

    await writeFile(path.join(directory, pkg.file), bytes);
    integrities[pkg.name] = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  }

  await writeFile(path.join(directory, 'index.json'), JSON.stringify(packages));
  await writeFile(path.join(directory, 'verified.json'), JSON.stringify({ integrities }));
  const published: string[][] = [];
  const packed: string[] = [];
  const requests: string[] = [];
  const existing = new Set<string>();
  const io: PublishServices = {
    pack: (pkg, file): void => {
      packed.push(pkg.name);
      writeFileSync(file, readFileSync(path.join(directory, pkg.file)));
    },
    publish: (args): void => {
      published.push(args);
      const pkg = packages.find(pkg => path.join(directory, pkg.file) === args[1])!;

      existing.add(pkg.name);
    },
    fetch: async (url): Promise<Response> => {
      requests.push(url);
      const pkg = packages.find(pkg => url.split('/').at(-2) === encodeURIComponent(pkg.name))!;

      return existing.has(pkg.name)
        ? Response.json({ dist: { integrity: integrities[pkg.name] } })
        : new Response('', { status: 404 });
    },
    log: (): void => {
    },
    cliArtifact: (): string => path.join(directory, 'cli.tgz'),
  };

  return { root, directory, packages, io, packed, published, requests, existing };
}

test('publishes only Builder packages, dependencies first, using checked tarballs and latest', async (t) => {
  const f = await fixture(t);

  await publishRelease(f.root, publishOptions([]), f.io);
  assert.deepEqual(f.published.map(args => path.basename(args[1])), ['plugin.tgz', 'builder.tgz']);
  assert.ok(f.published.every(args => args.join(' ').endsWith('--access public --tag latest')));
  assert.ok(f.packed.every(name => name !== '@bedrock-core/cli'));
});
test('CLI scope publishes only the exact smoke-tested CLI archive', async (t) => {
  const f = await fixture(t);

  await publishRelease(f.root, publishOptions(['--scope', 'cli']), f.io);
  assert.equal(f.published.length, 1);
  assert.equal(path.basename(f.published[0][1]), 'cli.tgz');
  assert.deepEqual(f.packed, ['@bedrock-core/cli']);
});
test('dry runs make no registry requests, publishes or authentication attempts', async (t) => {
  const f = await fixture(t);

  await writeFile(path.join(f.root, '.changeset/pending.md'), 'queued');
  await publishRelease(f.root, publishOptions(['--dry-run']), f.io);
  assert.equal(f.published.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.packed.length, 2);
});
test('actual publication requires applied Changesets', async (t) => {
  const f = await fixture(t);

  await writeFile(path.join(f.root, '.changeset/pending.md'), 'queued');
  await assert.rejects(publishRelease(f.root, publishOptions([]), f.io), /Apply queued Changesets/);
  assert.equal(f.packed.length, 0);
  assert.equal(f.published.length, 0);
});
test('rejects stale source anywhere in the selected group before the first publish', async (t) => {
  const f = await fixture(t);
  const pack = f.io.pack;

  f.io.pack = (pkg, file): void => {
    pack(pkg, file);

    if (pkg.name === '@bedrock-core/builder') {
      writeFileSync(file, 'changed source');
    }
  };

  await assert.rejects(publishRelease(f.root, publishOptions([]), f.io), /Package files changed/);
  assert.equal(f.published.length, 0);
  assert.equal(f.requests.length, 0);
});
test('rejects changed archives before publishing', async (t) => {
  const f = await fixture(t);

  await writeFile(path.join(f.directory, 'plugin.tgz'), 'changed tarball');
  await assert.rejects(publishRelease(f.root, publishOptions([]), f.io), /Run yarn test:packages/);
  assert.equal(f.published.length, 0);
});
test('rejects private or mismatched source package metadata', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));

  await writeFile(file, JSON.stringify({ ...manifest, private: true }));
  await assert.rejects(publishRelease(f.root, publishOptions([]), f.io), /private/);
  assert.equal(f.published.length, 0);
});
test('skips previously published matching archives', async (t) => {
  const f = await fixture(t);

  f.existing.add('@bedrock-core/builder-plugin');
  f.existing.add('@bedrock-core/builder');
  await publishRelease(f.root, publishOptions([]), f.io);
  assert.equal(f.published.length, 0);
  assert.equal(f.requests.length, 2);
});
test('refuses a registry version with different archive contents', async (t) => {
  const f = await fixture(t);

  f.io.fetch = async (): Promise<Response> => Response.json({ dist: { integrity: 'different' } });
  await assert.rejects(publishRelease(f.root, publishOptions([]), f.io), /Registry version differs/);
  assert.equal(f.published.length, 0);
});
test('prerelease archives default to next', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.1');

  await publishRelease(f.root, publishOptions([]), f.io);
  assert.ok(f.published.every(args => args.at(-1) === 'next'));
});
test('CLI publication rejects an artifact different from the passing smoke candidate', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other.tgz');

  await writeFile(other, 'other archive');
  f.io.cliArtifact = (): string => other;
  await assert.rejects(publishRelease(f.root, publishOptions(['--scope', 'cli']), f.io), /smoke-tested artifact differs/);
  assert.equal(f.published.length, 0);
  assert.equal(f.requests.length, 0);
});
test('rejects unknown scopes and refuses prereleases on latest', async (t) => {
  assert.throws(() => publishOptions(['--scope', 'all']), /Usage/);
  const f = await fixture(t, '0.1.0-alpha.1');

  await assert.rejects(publishRelease(f.root, publishOptions(['--tag', 'latest']), f.io), /non-latest/);
  assert.equal(f.published.length, 0);
});
