import path from 'node:path';
import type { MigrationOptions, ReportDiagnostic } from './types.ts';
import { isRecord } from './types.ts';

function literalPath(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function folderName(value: unknown, name: unknown, suffix: string): string | undefined {
  if (value === undefined || value === `project.name+'${suffix}'` || value === `project.name+"${suffix}"`) {
    return typeof name === 'string' ? `${name}${suffix}` : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  // Recognize quoted constants without evaluating Go-Simple-Eval expressions.
  const match = /^(?:'([^'\\]*)'|"([^"\\]*)")$/.exec(value);

  return match?.[1] ?? match?.[2];
}

/** Resolve supported targets to literal, exact pack folders. */
export function convertExport(
  selection: unknown,
  packs: Record<string, string>,
  projectName: unknown,
  profileName: string,
  options: MigrationOptions,
  report: ReportDiagnostic,
  location: string,
): Record<string, string> | undefined {
  const replacement = Object.hasOwn(options.exports ?? {}, profileName) ? options.exports![profileName] : undefined;

  if (replacement !== undefined) {
    report('export-replaced', location, 'Using explicitly supplied per-pack destinations for this profile.', 'warning');

    return structuredClone(replacement);
  }

  if (Array.isArray(selection)) {
    if (selection.length !== 1) {
      report('multiple-exports', location, 'Multiple export targets need separate builder profiles. Select exact destinations with --export profile:pack=path.');

      return undefined;
    }

    selection = selection[0];
  }

  if (!isRecord(selection)) {
    report('export-required', location, 'Provide export destinations with --export profile:pack=path for every pack.');

    return undefined;
  }

  const target = selection.target;
  const allowed = target === 'local' ? ['target', 'bpName', 'rpName', 'readOnly', 'build'] : ['target', 'bpPath', 'rpPath', 'readOnly'];

  if (target !== 'local' && target !== 'exact') {
    report('export-target', location, `Export target ${String(target)} needs literal destinations. Use --export profile:pack=path for every pack.`);

    return undefined;
  }

  for (const key of Object.keys(selection)) {
    if (!allowed.includes(key)) {
      report('export-property', `${location}/${key}`, 'This export property has no equivalent. Supply an explicit replacement export map.');
    }
  }

  if (selection.readOnly !== undefined && selection.readOnly !== false) {
    report('readonly-export', `${location}/readOnly`, 'Read-only export permissions need manual handling or an explicit replacement export map.');
  }

  const destinations: [string, string][] = [];

  for (const id of Object.keys(packs)) {
    const kind = Object.hasOwn(options.packKinds ?? {}, id)
      ? options.packKinds![id]
      : id === 'behaviorPack' ? 'behavior' : id === 'resourcePack' ? 'resource' : 'other';

    if (kind === 'other') {
      report('export-pack-kind', location, `Pack ${id} needs an explicit destination with --export ${profileName}:${id}=path.`);
      continue;
    }

    const prefix = kind === 'behavior' ? 'bp' : 'rp';
    let destination: unknown = selection[`${prefix}Path`];

    if (target === 'local') {
      const folder = folderName(selection[`${prefix}Name`], projectName, `_${prefix}`);

      if (!folder || folder === '.' || folder === '..' || /[/\\]/.test(folder)) {
        report('export-expression', `${location}/${prefix}Name`, `Folder expressions cannot be evaluated. Supply --export ${profileName}:${id}=path.`);
        continue;
      }

      destination = path.posix.join('build', folder);
    }

    if (!literalPath(destination)) {
      report('export-path', `${location}/${prefix}Path`, `Provide a literal path for ${id}; environment substitutions are not evaluated.`);
      continue;
    }

    destinations.push([id, destination]);
  }

  if (destinations.length !== Object.keys(packs).length) {
    return undefined;
  }

  if (new Set(destinations.map(([, destination]) => destination)).size !== destinations.length) {
    report('export-collision', location, 'Packs resolve to the same folder. Supply distinct destinations for every pack.');
  }

  return Object.fromEntries(destinations);
}
