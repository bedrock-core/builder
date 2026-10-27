import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { verifiedCliTarball } from './cli-artifact.mjs';
import { yarn } from './yarn.ts';
export interface ReleasePackage {
  name: string;
  version: string;
  file: string;
  workspace: string;
}
interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}
export interface PublishOptions {
  scope: 'builder' | 'cli';
  dryRun: boolean;
  tag?: string;
}
export interface PublishServices {
  pack: (pkg: ReleasePackage, file: string) => void;
  publish: (args: string[]) => void;
  fetch: (url: string) => Promise<Response>;
  log: (message: string) => void;
  cliArtifact: (version: string) => string;
  released?: (pkg: ReleasePackage) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}
const repository = fileURLToPath(new URL('../', import.meta.url));
const integrity = (bytes: Uint8Array): string => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

export function publishOptions(args: readonly string[]): PublishOptions {
  const result: PublishOptions = { scope: 'builder', dryRun: false };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--scope' && (args[index + 1] === 'builder' || args[index + 1] === 'cli')) {
      result.scope = args[++index] as PublishOptions['scope'];
    } else if (arg === '--tag' && /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(args[index + 1] ?? '')) {
      result.tag = args[++index];
    } else {
      throw new Error('Usage: yarn publish-release [--scope builder|cli] [--tag name] [--dry-run]');
    }
  }

  return result;
}

export function selectRelease(packages: readonly ReleasePackage[], scope: PublishOptions['scope']): ReleasePackage[] {
  const selected = packages.filter(pkg => scope === 'cli'
    ? pkg.name === '@bedrock-core/cli'
    : pkg.name === '@bedrock-core/builder' || pkg.name.startsWith('@bedrock-core/builder-'));

  if (selected.length === 0) {
    throw new Error('No release archives for scope ' + scope);
  }

  return selected;
}

export function hasReleaseTag(root: string, pkg: ReleasePackage): boolean {
  return execFileSync('git', ['tag', '--list', pkg.name + '@' + pkg.version], { cwd: root, encoding: 'utf8' }).trim().length > 0;
}

function npm(args: string[], cwd: string): void {
  const windows = process.platform === 'win32';
  const executable = windows ? process.execPath : 'npm';
  const command = windows ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] : args;
  const result = spawnSync(executable, command, { cwd, stdio: 'inherit' });

  if (result.status !== 0) {
    throw new Error('npm ' + args[0] + ' failed', { cause: result.error });
  }
}

export async function publishRelease(root: string, options: PublishOptions, services?: PublishServices): Promise<void> {
  const directory = path.join(root, '.bedrock-core/release/tarballs');
  const packages = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')) as ReleasePackage[];
  const verification = JSON.parse(await readFile(path.join(directory, 'verified.json'), 'utf8')) as {
    integrities: Record<string, string>;
  };
  const selected = selectRelease(packages, options.scope);
  const io: PublishServices = services ?? {
    pack: (pkg, file): void => yarn(['workspace', pkg.name, 'pack', '--out', file], root),
    publish: (args): void => npm(args, root),
    fetch: url => fetch(url),
    log: message => console.info(message),
    cliArtifact: version => verifiedCliTarball(version),
    released: pkg => hasReleaseTag(root, pkg),
  };
  const released = new Set(selected.filter(pkg => io.released?.(pkg)).map(pkg => pkg.name));

  if (!options.dryRun) {
    const pending = (await readdir(path.join(root, '.changeset'))).filter(file => file.endsWith('.md') && file !== 'README.md');

    if (pending.length > 0) {
      throw new Error('Apply queued Changesets before publishing: ' + pending.join(', '));
    }
  }

  const manifests = new Map<string, Manifest>();

  for (const pkg of selected) {
    const manifest = JSON.parse(await readFile(path.join(root, pkg.workspace, 'package.json'), 'utf8')) as Manifest;

    if (manifest.private || manifest.name !== pkg.name || manifest.version !== pkg.version) {
      throw new Error('Release metadata changed or is private: ' + pkg.name);
    }

    manifests.set(pkg.name, manifest);
  }

  const ordered: ReleasePackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (pkg: ReleasePackage): void => {
    if (visited.has(pkg.name)) {
      return;
    }

    if (visiting.has(pkg.name)) {
      throw new Error('Cyclic release dependency: ' + pkg.name);
    }

    visiting.add(pkg.name);

    for (const name of Object.keys(manifests.get(pkg.name)!.dependencies ?? {})) {
      const dependency = selected.find(pkg => pkg.name === name);

      if (dependency !== undefined) {
        visit(dependency);
      } else if (name.startsWith('@bedrock-core/builder')) {
        throw new Error('Missing release dependency ' + name);
      }
    }

    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  };

  selected.forEach(visit);

  // Check every unreleased archive and current source before publishing any package.
  for (const pkg of ordered) {
    if (released.has(pkg.name)) {
      continue;
    }

    const archive = path.join(directory, pkg.file);
    const checked = integrity(await readFile(archive));

    if (verification.integrities[pkg.name] !== checked) {
      throw new Error('Run yarn test:packages for the current ' + pkg.name + ' tarball before publication');
    }

    if (options.scope === 'cli' && !options.dryRun && integrity(await readFile(io.cliArtifact(pkg.version))) !== checked) {
      throw new Error('The CLI smoke-tested artifact differs from the checked release archive');
    }

    const candidate = await mkdtemp(path.join(tmpdir(), 'builder-publish-check-'));

    try {
      const file = path.join(candidate, pkg.file);

      io.pack(pkg, file);

      if (integrity(await readFile(file)) !== checked) {
        throw new Error('Package files changed since verification: ' + pkg.name);
      }
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }

  for (const pkg of ordered) {
    if (released.has(pkg.name)) {
      io.log('skipped released ' + pkg.name + '@' + pkg.version);
      continue;
    }

    const tag = options.tag ?? (pkg.version.includes('-') ? 'next' : 'latest');

    if (tag === 'latest' && pkg.version.includes('-')) {
      throw new Error('Prerelease packages require a non-latest dist-tag');
    }

    if (options.dryRun) {
      io.log('checked ' + pkg.name + '@' + pkg.version + ' (' + tag + ', local dry run)');
      continue;
    }

    const registry = 'https://registry.npmjs.org/' + encodeURIComponent(pkg.name) + '/' + pkg.version;
    const existing = await io.fetch(registry);
    const expected = verification.integrities[pkg.name];

    if (existing.ok) {
      const published = await existing.json() as {
        dist: {
          integrity: string;
        };
      };

      if (published.dist.integrity !== expected) {
        throw new Error('Registry version differs from the checked tarball: ' + pkg.name);
      }

      io.log(pkg.name + '@' + pkg.version + ' is already published');
      continue;
    }

    if (existing.status !== 404) {
      throw new Error('Cannot check ' + pkg.name + ': registry HTTP ' + existing.status);
    }

    io.publish(['publish', path.join(directory, pkg.file), '--registry', 'https://registry.npmjs.org', '--access', 'public', '--tag', tag]);
    let response: Response;

    // npm can acknowledge publication while its registry metadata is still processing.
    for (let attempt = 0; ; attempt++) {
      response = await io.fetch(registry + '?verification=' + Date.now());

      if (response.ok || attempt === 30 || ![404, 429, 500, 502, 503, 504].includes(response.status)) {
        break;
      }

      io.log('Waiting for registry metadata: ' + pkg.name + '@' + pkg.version);
      await (io.wait ?? delay)(10_000);
    }

    if (!response.ok) {
      throw new Error('Cannot verify published ' + pkg.name + ': HTTP ' + response.status);
    }

    const published = await response.json() as {
      dist: {
        integrity: string;
      };
    };

    if (published.dist.integrity !== expected) {
      throw new Error('Published archive differs from verification: ' + pkg.name);
    }

    io.log('published and verified ' + pkg.name + '@' + pkg.version);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishRelease(repository, publishOptions(process.argv.slice(2)));
}
