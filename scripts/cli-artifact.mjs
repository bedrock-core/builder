import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Reuse the exact archive checked by the clean-install gate. Repacking here
// would sever that guarantee and could hide missing template files.
export function verifiedCliTarball(version, env = process.env) {
  const file = env.BEDROCK_CLI_TARBALL;
  const reportFile = env.BEDROCK_CLI_SMOKE_SUMMARY;

  if (!file || !reportFile) {
    throw new Error('CLI artifact verification requires BEDROCK_CLI_TARBALL and BEDROCK_CLI_SMOKE_SUMMARY from scripts/smoke-cli.mjs.');
  }

  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');

  if (report.passed !== true || report.version !== version || report.sha256 !== sha256
    || report.registryOnly !== true
    || !Array.isArray(report.projects)
    || !['npm', 'yarn', 'pnpm'].every(manager => ['full', 'script', 'resource'].every(preset => report.projects.some(project => project.manager === manager && project.preset === preset && project.passed === true)))) {
    throw new Error('The CLI tarball does not match a passing registry-only npm/yarn/pnpm smoke report for every project preset.');
  }

  return resolve(file);
}
