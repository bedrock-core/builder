import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { auditRelease } from './audit.ts';
import { files, hash, safe } from './files.ts';
import { extractTgz } from './inputs/tar.ts';
import { compareVersions, readReleases, releaseTag, reportsRoot, root } from './releases.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { publish: { type: 'boolean' } } });
const [version] = positionals;

if (positionals.length !== 1 || !releaseTag.test('v1.' + version)) {
  throw new Error('Usage: node src/pack.ts <version> [--publish]');
}

const releases = await readReleases();
const release = Object.hasOwn(releases, version) ? releases[version] : undefined;

if (!release) {
  throw new Error('Unknown Bedrock types release: ' + version);
}

const audit = await auditRelease(version);

if (values.publish && (audit.counts.newIssues || audit.counts.resolved)) {
  throw new Error('Review the vanilla audit and confirm remaining issues before publishing ' + version);
}

const output = path.join(reportsRoot, version);
const stage = await mkdtemp(path.join(output, 'package-'));
const npmPath = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined;
const npm = (args: string[]): string => execFileSync(npmPath ? process.execPath : 'npm', npmPath ? [npmPath, ...args] : args, {
  cwd: output,
  encoding: 'utf8',
  env: { ...process.env, npm_config_cache: path.join(stage, '.npm-cache') },
});

try {
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const manifest = Object.fromEntries(
    ['name', 'type', 'description', 'license', 'repository', 'exports', 'types', 'files', 'publishConfig'].map(key => [key, source[key]]),
  );
  const expected = { ...manifest, version, bedrockTypes: release };
  const exports = Object.values(source.exports as Record<string, string | { types: string }>);

  await cp(audit.outputPath, path.join(stage, 'dist'), { recursive: true });
  await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(expected, null, 2) + '\n');
  const contents = await files(stage);

  for (const entry of exports) {
    const target = typeof entry === 'string' ? entry : entry.types;

    if (!Object.hasOwn(contents, target.replace(/^\.\//, ''))) {
      throw new Error('Package export is missing from the generated release: ' + target);
    }
  }

  const [packed] = JSON.parse(npm(['pack', stage, '--ignore-scripts', '--json'])) as { filename: string }[];
  const archive = path.join(output, packed.filename);
  const bytes = await readFile(archive);
  const entries = extractTgz(bytes);

  if (entries.size !== Object.keys(contents).length || Object.entries(contents).some(([file, checksum]) => {
    const data = entries.get('package/' + file);

    return !data || hash(data) !== checksum;
  })) {
    throw new Error('Types archive differs from the checked declaration-only distribution');
  }

  if (Object.keys(contents).some(file => file.startsWith('dist/') && !file.endsWith('.d.ts') && !['dist/package.json', 'dist/attribution.txt'].includes(file))) {
    throw new Error('Types archive contains runtime files');
  }

  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');

  console.info(`Verified ${packed.filename} (${entries.size} files)`);

  if (values.publish) {
    const registry = 'https://registry.npmjs.org/' + encodeURIComponent(String(source.name));
    const response = await fetch(registry, { signal: AbortSignal.timeout(30000) });
    const metadata = response.ok
      ? await response.json() as { 'versions': Record<string, { dist: { integrity: string } }>; 'dist-tags': Record<string, string> }
      : undefined;

    if (!response.ok && response.status !== 404) {
      throw new Error('Cannot check npm registry: HTTP ' + response.status);
    }

    const existing = metadata?.versions[version];

    if (existing) {
      if (existing.dist.integrity !== integrity) {
        throw new Error('This version is published with a different integrity');
      }

      console.info('Already published ' + version);
    } else {
      const latest = metadata?.['dist-tags'].latest;
      const tag = version.endsWith('-preview')
        ? 'mc-' + version
        : !latest || compareVersions(version, latest) > 0 ? 'latest' : 'mc-' + version;

      console.info(npm(['publish', archive, '--registry', 'https://registry.npmjs.org', '--access', 'public', '--tag', tag, '--ignore-scripts']));
    }
  }
} finally {
  await safe(root, stage);
  await rm(stage, { recursive: true, force: true });
}
