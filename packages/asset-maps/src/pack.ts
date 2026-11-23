import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { files, hash, safe } from '../../bedrock-types/src/files.ts';
import { extractTgz } from '../../bedrock-types/src/inputs/tar.ts';
import { audit } from './audit.ts';
import { buildAssetMaps } from './build.ts';
import { compareVersions, readAssetRelease, releaseChannel } from './releases.ts';
import { root } from './paths.ts';

export function releaseTag(version: string, tags?: Record<string, string>): string {
  const channel = releaseChannel(version) === 'preview' ? 'preview' : 'latest';
  const current = tags?.[channel];

  return !current || compareVersions(version, current) > 0 ? channel : 'mc-' + version;
}

async function pack(version: string, { offline = false, publish = false } = {}): Promise<string> {
  const release = await readAssetRelease(version);
  const built = await buildAssetMaps({ version, offline });
  const result = await audit({ version, offline: true });
  const output = path.dirname(built.outputPath);

  await writeFile(path.join(output, 'audit.json'), JSON.stringify(result, null, 2) + '\n');

  if (result.errors.length || result.redundant.length || !result.targetCompatible) {
    throw new Error('Asset Maps audit failed for ' + version);
  }

  const stage = await mkdtemp(path.join(output, 'package-'));
  const npmPath = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined;
  const npm = (args: string[]): string => execFileSync(npmPath ? process.execPath : 'npm', npmPath ? [npmPath, ...args] : args, {
    cwd: output, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(stage, '.npm-cache') }, windowsHide: true,
  });

  try {
    const source: Record<string, unknown> = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const manifest = Object.fromEntries(['name', 'type', 'description', 'license', 'repository', 'exports', 'files', 'publishConfig'].map(key => [key, source[key]]));

    await Promise.all([
      cp(built.outputPath, path.join(stage, 'dist'), { recursive: true }),
      cp(path.join(root, 'README.md'), path.join(stage, 'README.md')),
      cp(path.join(root, 'SOURCES.md'), path.join(stage, 'SOURCES.md')),
      writeFile(path.join(stage, 'package.json'), JSON.stringify({ ...manifest, version, assetMaps: { samplesTag: release.entry.samplesTag, samplesSha256: release.entry.samplesSha256 } }, null, 2) + '\n'),
    ]);
    const contents = await files(stage);

    for (const target of Object.values(source.exports as Record<string, string>)) {
      const name = target.slice(2);

      if (name.endsWith('*') ? !Object.keys(contents).some(file => file.startsWith(name.slice(0, -1))) : !Object.hasOwn(contents, name)) {
        throw new Error('Asset Maps package export is missing: ' + target);
      }
    }

    if (Object.keys(contents).some(file => file.startsWith('dist/') && !/\.(?:json|txt)$/.test(file))) {
      throw new Error('Asset Maps distribution contains files other than JSON and source notices');
    }

    const [packed] = JSON.parse(npm(['pack', stage, '--ignore-scripts', '--json'])) as { filename: string }[];
    const archive = path.join(output, packed.filename);
    const bytes = await readFile(archive);
    const entries = extractTgz(bytes);

    if (entries.size !== Object.keys(contents).length || Object.entries(contents).some(([file, checksum]) => {
      const data = entries.get('package/' + file);

      return !data || hash(data) !== checksum;
    })) {
      throw new Error('Asset Maps archive differs from the audited distribution');
    }

    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');

    if (publish) {
      const registry = 'https://registry.npmjs.org';
      const response = await fetch(registry + '/' + encodeURIComponent(String(source.name)), { signal: AbortSignal.timeout(30000) });
      const metadata = response.ok
        ? await response.json() as {
          'versions': Record<string, { dist: { integrity: string } }>;
          'dist-tags': Record<string, string>;
        }
        : undefined;

      if (!response.ok && response.status !== 404) {
        throw new Error('Cannot check npm registry: HTTP ' + response.status);
      }

      const existing = metadata?.versions[version];

      if (existing && existing.dist.integrity !== integrity) {
        throw new Error('This Asset Maps version is already published with a different integrity');
      }

      if (existing) {
        console.info('Already published ' + version);
      } else {
        console.info(npm(['publish', archive, '--registry', registry, '--access', 'public', '--tag', releaseTag(version, metadata?.['dist-tags']), '--ignore-scripts']));
      }
    }

    console.info(`Verified ${packed.filename} (${entries.size} files)`);

    return archive;
  } finally {
    await safe(root, stage);
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { offline: { type: 'boolean' }, publish: { type: 'boolean' } } });

  if (positionals.length !== 1 || (values.offline && values.publish)) {
    throw new Error('Usage: node src/pack.ts <version> [--offline | --publish]');
  }

  console.info(await pack(positionals[0], values));
}
