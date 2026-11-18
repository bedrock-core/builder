import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateWithCreatorTools, type CreatorToolsResult } from '../../../validation/src/creator-tools.ts';
import { safe } from '../files.ts';
import { readSampleEntries } from '../inputs/metadata.ts';
import { root } from '../releases.ts';
import type { AuditedDocument } from './documents.ts';

const structuralRules = new Set(['JSON', 'COMJSON', 'JSONF']);

export async function compareCreatorTools(
  archive: string,
  output: string,
  files: readonly AuditedDocument[],
  projectRoot: string,
): Promise<{ report: CreatorToolsResult; documents: { path: string; typeStatus: string; creatorRules: string[] }[] }> {
  const workspace = await mkdtemp(path.join(output, 'samples-'));
  const directories = new Set<string>();

  try {
    await readSampleEntries(archive, name => /^(behavior_pack|resource_pack)\//.test(name), async (name, bytes) => {
      const target = path.join(workspace, name);
      const directory = path.dirname(target);

      if (!directories.has(directory)) {
        await safe(workspace, directory);
        await mkdir(directory, { recursive: true });
        directories.add(directory);
      }

      await writeFile(target, bytes);
    });
    const report = await validateWithCreatorTools([
      { id: 'behavior_pack', path: path.join(workspace, 'behavior_pack'), kind: 'behavior' },
      { id: 'resource_pack', path: path.join(workspace, 'resource_pack'), kind: 'resource' },
    ], { mode: 'warn', projectRoot });
    const rulesByFile = new Map<string, Set<string>>();

    for (const issue of report.diagnostics) {
      if (!structuralRules.has(issue.rule) || issue.severity === 'recommendation' || !issue.file) {
        continue;
      }

      const file = issue.pack + '/' + issue.file;
      const rules = rulesByFile.get(file) ?? new Set<string>();

      rules.add(issue.rule);
      rulesByFile.set(file, rules);
    }

    return {
      report,
      documents: files.map(file => ({
        path: file.path,
        typeStatus: file.status,
        creatorRules: [...rulesByFile.get(file.path) ?? []].sort(),
      })),
    };
  } finally {
    await safe(root, workspace);
    await rm(workspace, { recursive: true, force: true });
  }
}
