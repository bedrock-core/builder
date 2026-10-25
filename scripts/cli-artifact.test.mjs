import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifiedCliTarball } from './cli-artifact.mjs';

test('CLI artifact verification accepts only the exact archive with all successful installs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-test-'));

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cli.tgz');
  const reportFile = join(dir, 'summary.json');
  const env = { BEDROCK_CLI_TARBALL: file, BEDROCK_CLI_SMOKE_SUMMARY: reportFile };

  writeFileSync(file, 'tested archive');
  const report = {
    version: '0.11.1', passed: true, registryOnly: true,
    sha256: createHash('sha256').update('tested archive').digest('hex'),
    projects: ['npm', 'yarn', 'pnpm'].flatMap(manager => ['full', 'script', 'resource'].map(preset => ({ manager, preset, passed: true }))),
  };
  const save = value => writeFileSync(reportFile, JSON.stringify(value));

  save(report);
  assert.equal(verifiedCliTarball('0.11.1', env), file);
  assert.throws(() => verifiedCliTarball('0.11.2', env), /does not match/);
  assert.throws(() => verifiedCliTarball('0.11.1', {}), /requires/);

  for (const invalid of [
    { ...report, passed: false },
    { ...report, registryOnly: false },
    { ...report, projects: report.projects.filter(project => project.preset !== 'resource') },
    { ...report, projects: report.projects.slice(0, 1) },
    { ...report, projects: [{ manager: 'npm', passed: true }, { manager: 'yarn', passed: false }, { manager: 'pnpm', passed: true }] },
    { ...report, projects: undefined },
  ]) {
    save(invalid);
    assert.throws(() => verifiedCliTarball('0.11.1', env), /does not match/);
  }

  save(report);
  writeFileSync(file, 'repacked archive');
  assert.throws(() => verifiedCliTarball('0.11.1', env), /does not match/);
});
