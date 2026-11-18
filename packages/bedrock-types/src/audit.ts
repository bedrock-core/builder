import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildBedrockTypes } from './build.ts';
import { auditDocuments } from './audit/documents.ts';
import { compareCreatorTools } from './audit/creator-tools.ts';
import { files, hash, safe } from './files.ts';
import { sampleArchive } from './inputs/metadata.ts';
import { archiveCache, compareVersions, metadataSource, readReleases, reportsRoot, root } from './releases.ts';

const confirmationsFile = path.join(root, 'confirmed-issues.json');

type Confirmations = Record<string, { reason: string; issues: string[] }[]>;

export async function auditRelease(version: string, creatorTools?: string) {
  const releases = await readReleases();
  const release = Object.hasOwn(releases, version) ? releases[version] : undefined;

  if (!release) {
    throw new Error('Unknown Bedrock types version: ' + version);
  }

  const { outputPath } = await buildBedrockTypes(version);
  const output = path.join(reportsRoot, version);
  const archive = await sampleArchive(metadataSource(release), archiveCache, process.env.BC_NATIVE_SCHEMA_ARCHIVE);
  const documents = await auditDocuments(archive, outputPath);
  const ledger = JSON.parse(await readFile(confirmationsFile, 'utf8')) as Confirmations;
  const recorded = new Map((ledger[version] ?? []).flatMap(group => group.issues.map(id => [id, group.reason] as const)));
  const confirmed = new Map(
    Object.keys(ledger).filter(pin => compareVersions(pin, version) <= 0).sort(compareVersions)
      .flatMap(pin => ledger[pin].flatMap(group => group.issues.map(id => [id, group.reason] as const))),
  );
  const present = new Set(documents.flatMap(file => file.issue ? [file.issue] : []));
  const issues = documents.filter(file => file.issue && !confirmed.has(file.issue));
  const resolved = [...recorded].filter(([id]) => !present.has(id)).map(([id, reason]) => ({ id, reason }));
  const counts = {
    total: documents.length,
    passed: documents.filter(file => file.status === 'passed').length,
    typeErrors: documents.filter(file => file.status === 'type-error').length,
    syntaxErrors: documents.filter(file => file.status === 'syntax-error').length,
    uncovered: documents.filter(file => file.status === 'uncovered').length,
    excluded: documents.filter(file => file.status === 'excluded').length,
    legacyDocuments: documents.filter(file => file.compatibility === 'legacy').length,
    vanillaDocuments: documents.filter(file => file.compatibility === 'vanilla').length,
    withInternalProperties: documents.filter(file => file.ignoredProperties?.length).length,
    confirmed: present.size - issues.length,
    newIssues: issues.length,
    resolved: resolved.length,
  };

  await safe(root, output);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'vanilla.json'), JSON.stringify({
    version,
    release,
    declarations: hash(JSON.stringify(await files(outputPath))),
    counts,
    resolved,
    documents: documents.map(file => ({ ...file, confirmation: file.issue ? confirmed.get(file.issue) : undefined })),
  }, null, 2) + '\n');
  console.info(`Vanilla ${version} (${release.samplesTag}) ${JSON.stringify(counts)}`);

  if (creatorTools) {
    const comparison = await compareCreatorTools(archive, output, documents, creatorTools);
    const summary = comparison.report.rules.length
      ? {
          typePassWithCreatorFinding: comparison.documents.filter(file => file.typeStatus === 'passed' && file.creatorRules.length).length,
          typeFailureWithoutCreatorFinding: comparison.documents.filter(file => file.typeStatus === 'type-error' && !file.creatorRules.length).length,
          bothFlagged: comparison.documents.filter(file => file.typeStatus === 'type-error' && file.creatorRules.length).length,
        }
      : undefined;

    await writeFile(path.join(output, 'creator-tools.json'), JSON.stringify({ version, summary, ...comparison }, null, 2) + '\n');

    if (!summary) {
      throw new Error(comparison.report.diagnostics[0]?.message ?? 'Creator Tools comparison returned no rules');
    }

    console.info(`Creator Tools ${comparison.report.version ?? 'unavailable'} ${JSON.stringify(summary)}`);
  }

  return { counts, issues, resolved, outputPath };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'check': { type: 'boolean' },
      'creator-tools': { type: 'string' },
      'confirm': { type: 'string', multiple: true },
      'reason': { type: 'string' },
    },
  });
  const versions = positionals.length ? positionals : Object.keys(await readReleases()).sort(compareVersions);
  const confirm = values.confirm ?? [];
  const reason = values.reason?.trim();

  if (confirm.length && (positionals.length !== 1 || !reason)) {
    throw new Error('Confirm issues with audit <version> --confirm <issue ID> --reason <reason>.');
  }

  for (const version of versions) {
    const { counts, issues } = await auditRelease(version, values['creator-tools']);

    if (confirm.length) {
      const ledger = JSON.parse(await readFile(confirmationsFile, 'utf8')) as Confirmations;
      const groups = ledger[version] ?? [];
      const group = groups.find(group => group.reason === reason) ?? { reason: reason!, issues: [] };

      for (const id of confirm) {
        const issue = issues.find(file => file.issue === id);

        if (!issue) {
          throw new Error('No new issue matches ' + id);
        }

        group.issues.push(id);
      }

      group.issues = [...new Set(group.issues)].sort();
      ledger[version] = groups.includes(group) ? groups : [...groups, group];
      await writeFile(confirmationsFile, JSON.stringify(ledger, null, 2) + '\n');
    } else if (values.check && (counts.newIssues || counts.resolved)) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
