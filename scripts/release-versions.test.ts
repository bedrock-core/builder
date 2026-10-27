import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const changesetBin = fileURLToPath(import.meta.resolve('@changesets/cli/bin.js'));
const releaseConfig = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url), 'utf8'));
const BUILDER = '@bedrock-core/builder';
const UI = '@bedrock-core/builder-ui';
const GUIDES = '@bedrock-core/builder-guides';
const VALIDATION = '@bedrock-core/builder-validation';
const PLUGIN = '@bedrock-core/builder-plugin';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'builder-release-versions-'));

  const put = (file: string, value: unknown): void => {
    const target = join(root, file);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
  };

  const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'yarn.lock'), '');
  put('package.json', {
    name: BUILDER, version: '1.4.0', packageManager: 'yarn@4.16.0', workspaces: ['.', 'packages/*'],
    dependencies: { [UI]: 'workspace:*', [GUIDES]: 'workspace:*', [VALIDATION]: 'workspace:*', [PLUGIN]: 'workspace:*' },
  });
  put('packages/ui/package.json', { name: UI, version: '0.2.0', dependencies: { [PLUGIN]: 'workspace:*' } });
  put('packages/guides/package.json', { name: GUIDES, version: '2.5.0', dependencies: { [PLUGIN]: 'workspace:*' } });
  put('packages/validation/package.json', { name: VALIDATION, version: '3.1.0' });
  put('packages/plugin/package.json', { name: PLUGIN, version: '0.7.0' });
  put('.changeset/config.json', { ...releaseConfig, changelog: false, commit: false });

  return {
    read,
    release(releases: Record<string, string>): void {
      const entries = Object.entries(releases).map(([name, bump]) => `"${name}": ${bump}`).join('\n');

      writeFileSync(join(root, '.changeset/release.md'), `---\n${entries}\n---\n\nUpdate package APIs.\n`);
      execFileSync(process.execPath, [changesetBin, 'version'], { cwd: root, env: { ...process.env, CI: 'true' } });
    },
  };
}

test('a UI minor leaves unrelated plugin versions unchanged', (t) => {
  const f = fixture(t);

  f.release({ [UI]: 'minor' });
  assert.equal(f.read('packages/ui/package.json').version, '0.3.0');
  assert.equal(f.read('packages/guides/package.json').version, '2.5.0');
  assert.equal(f.read('packages/validation/package.json').version, '3.1.0');
  assert.equal(f.read('packages/plugin/package.json').version, '0.7.0');
  assert.equal(f.read('package.json').version, '1.4.1');
});

test('mixed plugin changes retain their own release levels', (t) => {
  const f = fixture(t);

  f.release({ [UI]: 'minor', [GUIDES]: 'patch', [VALIDATION]: 'patch' });
  assert.equal(f.read('packages/ui/package.json').version, '0.3.0');
  assert.equal(f.read('packages/guides/package.json').version, '2.5.1');
  assert.equal(f.read('packages/validation/package.json').version, '3.1.1');
  assert.equal(f.read('packages/plugin/package.json').version, '0.7.0');
  assert.equal(f.read('package.json').version, '1.4.1');
});

test('dependency changes update pinned consumers without bumping unrelated plugins', (t) => {
  const f = fixture(t);

  f.release({ [PLUGIN]: 'patch' });
  assert.equal(f.read('packages/plugin/package.json').version, '0.7.1');
  assert.equal(f.read('packages/ui/package.json').version, '0.2.1');
  assert.equal(f.read('packages/guides/package.json').version, '2.5.1');
  assert.equal(f.read('packages/validation/package.json').version, '3.1.0');
  assert.equal(f.read('package.json').version, '1.4.1');
});
