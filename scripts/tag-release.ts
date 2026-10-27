import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasReleaseTag, publishOptions, selectRelease, type ReleasePackage } from './publish-release.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const options = publishOptions(process.argv.slice(2));
const directory = path.join(root, '.bedrock-core/release/tarballs');
const packages = selectRelease(JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')) as ReleasePackage[], options.scope)
  .filter(pkg => !hasReleaseTag(root, pkg));
const verification = JSON.parse(await readFile(path.join(directory, 'verified.json'), 'utf8')) as {
  integrities: Record<string, string>;
};

if (!options.dryRun) {
  const changed = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim();

  if (changed) {
    throw new Error('Commit the release source before creating package tags:\n' + changed);
  }

  for (const pkg of packages) {
    const manifest = JSON.parse(await readFile(path.join(root, pkg.workspace, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      private?: boolean;
    };

    if (manifest.private || manifest.name !== pkg.name || manifest.version !== pkg.version) {
      throw new Error('Package metadata differs from the release archive: ' + pkg.name);
    }

    const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(pkg.name) + '/' + pkg.version);

    if (!response.ok) {
      throw new Error('Publish ' + pkg.name + '@' + pkg.version + ' before tagging');
    }

    const published = await response.json() as {
      dist: {
        integrity: string;
      };
    };

    if (published.dist.integrity !== verification.integrities[pkg.name]) {
      throw new Error('Registry archive does not match verification: ' + pkg.name);
    }
  }
}

for (const pkg of packages) {
  const tag = pkg.name + '@' + pkg.version;
  const exists = execFileSync('git', ['tag', '--list', tag], { cwd: root, encoding: 'utf8' }).trim().length > 0;

  if (options.dryRun) {
    console.info(tag + (exists ? ' already exists' : ' would create'));
  } else {
    if (!exists) {
      execFileSync('git', ['tag', '-a', tag, '-m', tag], { cwd: root, stdio: 'inherit' });
    }

    if (process.env.CHANGESETS_OUTPUT) {
      await appendFile(process.env.CHANGESETS_OUTPUT, JSON.stringify({ type: 'git-tag', tag, packageName: pkg.name }) + '\n');
    }

    console.info('tag ' + tag);
  }
}
