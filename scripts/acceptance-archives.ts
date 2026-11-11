import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AcceptanceArchive {
  name: string;
  version: string;
  file: string;
  integrity: string;
}

export interface AcceptanceArchiveIndex {
  sources: { repository: string; commit: string }[];
  packages: AcceptanceArchive[];
}

const names = new Set([
  '@bedrock-core/ui', '@bedrock-core/ui-runtime', '@bedrock-core/ui-compiler',
  '@bedrock-core/navigation', '@bedrock-core/ore-styled', '@bedrock-core/flexbox', '@bedrock-core/guides',
]);

export const archiveIntegrity = (bytes: Uint8Array): string => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
export const acceptanceYarnConfig = 'nodeLinker: node-modules\nenableGlobalCache: true\nnpmPreapprovedPackages:\n  - "@bedrock-core/*"\n';

/** Resolve only checked fixture archives, leaving the Builder release cohort separate. */
export async function acceptanceArchives(file: string | undefined) {
  const resolutions: Record<string, string> = {};

  if (!file) {
    return { resolutions, evidence: undefined };
  }

  const index = JSON.parse(await readFile(file, 'utf8')) as AcceptanceArchiveIndex;

  assert.ok(index.sources.length > 0 && index.packages.length > 0, 'Acceptance archives need source and package evidence');
  assert.ok(index.sources.every(source => /^bedrock-core\/(ui|apps)$/.test(source.repository) && /^[a-f0-9]{40}$/.test(source.commit)), 'Acceptance sources need repository commit identities');

  for (const pkg of index.packages) {
    assert.ok(names.has(pkg.name) && !Object.hasOwn(resolutions, pkg.name), 'Unexpected or duplicate acceptance package: ' + pkg.name);
    assert.ok(pkg.file.endsWith('.tgz') && !/[\\/]/.test(pkg.file) && pkg.file === path.basename(pkg.file), 'Acceptance archive must be a filename');
    const archive = path.resolve(path.dirname(file), pkg.file);

    assert.equal(archiveIntegrity(await readFile(archive)), pkg.integrity, 'Acceptance archive changed: ' + pkg.name);
    resolutions[pkg.name] = `file:${archive.replaceAll('\\', '/')}`;
  }

  return { resolutions, evidence: index };
}
