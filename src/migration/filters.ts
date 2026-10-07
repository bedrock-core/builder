import path from 'node:path';
import type { StageName, StageSelection, Settings } from '../config.ts';
import { stages } from '../plan.ts';
import type { FilterKind, MigrationOptions, ReportDiagnostic } from './types.ts';
import { isRecord, pointer } from './types.ts';

interface FilterEntry {
  stage: StageName;
  settings: Settings;
  location: string;
}

const keys: Record<StageName, readonly string[]> = {
  'manifest': ['manifestPath', 'pretty'],
  'generator': ['include', 'exclude', 'pretty', 'types', 'schemaVersion', 'typesDir', 'strict', 'typePrefix', 'maxAgeHours'],
  'guides': [],
  'i18n': ['namespace', 'sourceDir', 'defaultLocale', 'strict', 'vanilla', 'vanillaLangUrlTemplate', 'cacheMaxAgeHours', 'pretty'],
  'ui-compiler': ['namespace', 'testMetadata', 'stamp', 'screens', 'pretty'],
  'bundler': ['debug', 'tsConfigPath'],
};

function filterKind(id: string, definition: unknown, options: MigrationOptions): FilterKind | undefined {
  if (Object.hasOwn(options.filters ?? {}, id)) {
    return options.filters![id];
  }

  if (!isRecord(definition) || typeof definition.url !== 'string' || definition.script !== undefined || definition.runWith !== undefined) {
    return undefined;
  }

  const match = /^(?:https:\/\/)?github\.com\/bedrock-core\/regolith-filters(?:\/([a-z-]+))?\/?$/i.exec(definition.url);
  const name = match?.[1] ?? (match ? id : undefined);

  return name === 'core' || stages.some(stage => stage === name) ? name as FilterKind : undefined;
}

/** Translate Regolith workspace prefixes into authored project paths. */
function projectPath(value: string, packs: Record<string, string>, dataPath: unknown, report: ReportDiagnostic, location: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^packs\//, '');
  const candidates: string[] = [];

  for (const directory of Object.values(packs)) {
    const source = directory.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    const staged = source.replace(/^packs\//, '');

    if (normalized === staged || normalized.startsWith(`${staged}/`)) {
      candidates.push(`${source}${normalized.slice(staged.length)}`);
    }
  }

  if (normalized === 'data' || normalized.startsWith('data/')) {
    if (typeof dataPath === 'string') {
      candidates.push(`${dataPath.replaceAll('\\', '/').replace(/\/$/, '')}${normalized.slice(4)}`);
    } else {
      report('data-source', location, 'Set an explicit project-relative source path; the Regolith data folder is not configured.');
    }
  }

  if (new Set(candidates).size > 1) {
    report('ambiguous-source-path', location, `Path ${value} matches multiple Regolith workspace roots. Convert it to a project-relative path manually.`);
  }

  return candidates[0] ?? value;
}

function settingsFor(
  entry: FilterEntry,
  packs: Record<string, string>,
  dataPath: unknown,
  report: ReportDiagnostic,
): StageSelection {
  const { stage, settings, location } = entry;

  if (stage === 'guides') {
    report('stage-unavailable', location, `The ${stage} builder stage is not implemented. Keep this profile on Regolith until its integration is available.`);

    return Object.keys(settings).length ? settings : 'auto';
  }

  const converted: Settings = {};

  function pattern(value: unknown, key: string): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    const mapped = projectPath(value, packs, dataPath, report, location);
    const normalized = mapped.replaceAll('\\', '/').replace(/^\.\//, '');
    const insidePack = Object.values(packs).some((directory) => {
      const root = directory.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');

      return normalized.startsWith(`${root}/`);
    });

    if (value.startsWith('!') || (key === 'include' && (!insidePack || normalized.split('/').includes('..')))) {
      report('generator-pattern', `${location}/settings/${key}`, 'Use project-relative patterns inside configured packs; broad or negated template includes need manual conversion.');
    }

    return mapped;
  }

  for (const [key, value] of Object.entries(settings)) {
    if (key === 'namespace' && stage !== 'i18n' && stage !== 'ui-compiler') {
      continue;
    }

    if (key === 'pretty' && stage === 'bundler') {
      continue;
    }

    if (!keys[stage].includes(key)) {
      report('filter-setting', `${location}/settings/${pointer(key)}`, `Setting ${key} has no verified ${stage} migration. Convert it manually.`);
      continue;
    }

    if (stage === 'manifest') {
      if (key === 'manifestPath') {
        const paths = Array.isArray(value) ? value : [value];

        for (const file of paths) {
          const mapped = typeof file === 'string' ? projectPath(file, packs, dataPath, report, location) : undefined;
          const canonical = mapped?.replace(/^\.\//, '');
          const matches = Object.values(packs).some(directory => `${directory.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')}/manifest.json` === canonical);

          if (!matches) {
            report('manifest-variant', `${location}/settings/manifestPath`, 'Manifest variants and extends chains need per-pack manifest overrides or a builder plugin. They are not rewritten automatically.');
          }
        }
      } else {
        report('manifest-formatting', `${location}/settings/pretty`, 'The builder preserves canonical manifest formatting unless overrides are applied.', 'warning');
      }

      continue;
    }

    if (key === 'include' || key === 'exclude') {
      converted[key] = Array.isArray(value) ? value.map(value => pattern(value, key)) : pattern(value, key);
    } else if (key === 'screens' && Array.isArray(value)) {
      converted.screens = value.map((source) => {
        if (typeof source !== 'string' || !source.startsWith('.')) {
          return source;
        }

        const mapped = projectPath(source, packs, dataPath, report, location);

        return mapped.startsWith('.') || path.isAbsolute(mapped) ? mapped : `./${mapped}`;
      });
    } else if (key === 'sourceDir' && typeof value === 'string') {
      converted.sourceDir = projectPath(value, packs, dataPath, report, location);
    } else {
      converted[key === 'tsConfigPath' ? 'tsconfig' : key] = structuredClone(value);
    }
  }

  if (stage === 'i18n') {
    converted.sourceDir ??= projectPath('data/i18n', packs, dataPath, report, location);
    report('i18n-declarations', location, 'Include .bedrock-core/generated/i18n in tsconfig for generated translation types. Runtime imports use @bedrock-core/generated/i18n.', 'warning');
  }

  if (stage === 'generator' && settings.types !== false) {
    report('generator-declarations', location, 'Include the configured generator declarations (default .bedrock-core/generated/mc/globals.d.ts) in tsconfig.', 'warning');
  }

  if (stage === 'bundler') {
    report('bundler-entry', location, 'Verify manifest script entries select the intended sources. tsconfig files/include do not select builder entry points; project code and tsconfig are not rewritten.', 'warning');
  }

  return Object.keys(converted).length ? converted : stage === 'generator' ? true : 'auto';
}

/** Flatten profile references and preserve the supported, fixed stage order. */
export function convertFilters(
  name: string,
  profiles: Record<string, unknown>,
  definitions: Record<string, unknown>,
  packs: Record<string, string>,
  dataPath: unknown,
  options: MigrationOptions,
  report: ReportDiagnostic,
): { stages: Partial<Record<StageName, StageSelection>>; namespaces: string[] } {
  const entries: FilterEntry[] = [];
  const namespaces = new Set<string>();
  let remaining = 10000;

  function add(stage: StageName, settings: Settings, location: string): void {
    if (typeof settings.namespace === 'string' && settings.namespace) {
      namespaces.add(settings.namespace);
    }

    entries.push({ stage, settings, location });
  }

  function visit(profileName: string, parents: string[]): void {
    const location = `/regolith/profiles/${pointer(profileName)}`;

    if (parents.includes(profileName) || parents.length > 64) {
      report('profile-cycle', location, `Profile references must be acyclic: ${[...parents, profileName].join(' -> ')}.`);

      return;
    }

    const profile = Object.hasOwn(profiles, profileName) ? profiles[profileName] : undefined;

    if (!isRecord(profile) || !Array.isArray(profile.filters)) {
      report('profile-reference', location, 'Profile must exist and contain a filters array.');

      return;
    }

    for (const key of Object.keys(profile)) {
      if (!['filters', 'export', 'preShell', 'postShell'].includes(key)) {
        report('profile-property', `${location}/${pointer(key)}`, 'This profile property needs manual conversion.');
      }
    }

    for (const key of ['preShell', 'postShell']) {
      const commands = profile[key];

      if (commands !== undefined && !(Array.isArray(commands) && commands.length === 0) && !(isRecord(commands) && Object.keys(commands).length === 0)) {
        report('shell-commands', `${location}/${key}`, 'Move shell commands and environment setup into a trusted TS/JS builder plugin. Migration does not execute commands.');
      }
    }

    for (const [index, item] of profile.filters.entries()) {
      const itemPath = `${location}/filters/${index}`;

      if (--remaining < 0) {
        report('profile-size', itemPath, 'Expanded profiles exceed the migration limit of 10000 entries.');

        return;
      }

      if (!isRecord(item)) {
        report('filter-entry', itemPath, 'Filter entries must be objects.');
        continue;
      }

      if (item.disabled === true) {
        continue;
      }

      if (item.disabled !== undefined && item.disabled !== false) {
        report('filter-disabled', `${itemPath}/disabled`, 'disabled must be a boolean.');
      }

      if (item.when !== undefined) {
        report('filter-condition', `${itemPath}/when`, 'Conditional execution needs separate profiles or a builder plugin. Expressions are not evaluated.');
        continue;
      }

      for (const key of Object.keys(item)) {
        if (!['filter', 'profile', 'settings', 'disabled', 'when', 'arguments', 'extraArguments'].includes(key)) {
          report(key === 'asyncFilters' ? 'parallel-filters' : 'filter-property', `${itemPath}/${pointer(key)}`, 'This filter property needs manual conversion; builder file transformations are sequential.');
        }
      }

      if (item.arguments !== undefined && !(Array.isArray(item.arguments) && item.arguments.length === 0)) {
        report('filter-arguments', `${itemPath}/arguments`, 'Convert CLI arguments to stage or plugin settings manually.');
      }

      if (item.extraArguments !== undefined && item.extraArguments !== 'ignore') {
        report('extra-arguments', `${itemPath}/extraArguments`, 'Runtime argument forwarding needs manual plugin handling.');
      }

      if (typeof item.profile === 'string' && item.filter === undefined) {
        if (item.settings !== undefined) {
          report('profile-settings', `${itemPath}/settings`, 'Settings on profile references need manual conversion.');
        }

        visit(item.profile, [...parents, profileName]);
        continue;
      }

      if (typeof item.filter !== 'string' || item.profile !== undefined) {
        report('filter-entry', itemPath, 'Use exactly one filter or profile reference.');
        continue;
      }

      const definition = Object.hasOwn(definitions, item.filter) ? definitions[item.filter] : undefined;
      const kind = filterKind(item.filter, definition, options);

      if (!isRecord(definition) || !kind || (kind !== 'core' && !stages.includes(kind))) {
        report('custom-filter', itemPath, `Filter ${item.filter} is not a verified @bedrock-core filter. Port it to a run(context, settings) plugin; use --filter id=stage only for a verified equivalent.`);
        continue;
      }

      for (const key of Object.keys(definition)) {
        if (!['url', 'version', 'runWith', 'script'].includes(key)) {
          report('filter-definition', `/regolith/filterDefinitions/${pointer(item.filter)}/${pointer(key)}`, 'This filter definition property needs manual conversion.');
        }
      }

      if (definition.runWith !== undefined && definition.runWith !== 'nodejs') {
        report('filter-runtime', itemPath, 'Only verified Node TS/JS filter equivalents can become built-in stages.');
      }

      if (definition.version !== undefined) {
        report('filter-version', itemPath, 'Built-in stages use the installed builder version. Verify output parity against the pinned Regolith filter version.', 'warning');
      }

      if (item.settings !== undefined && !isRecord(item.settings)) {
        report('filter-settings', `${itemPath}/settings`, 'Filter settings must be an object.');
        continue;
      }

      const settings = item.settings ?? {};

      if (kind !== 'core') {
        add(kind, settings, itemPath);
        continue;
      }

      for (const key of Object.keys(settings)) {
        if (key !== 'shared' && !stages.some(stage => stage === key)) {
          report('core-setting', `${itemPath}/settings/${pointer(key)}`, 'Expected shared settings or a built-in stage name.');
        }
      }

      const shared = settings.shared ?? {};

      if (!isRecord(shared)) {
        report('core-shared', `${itemPath}/settings/shared`, 'Shared settings must be an object.');
        continue;
      }

      for (const key of Object.keys(shared)) {
        if (!['namespace', 'pretty'].includes(key)) {
          report('core-shared-setting', `${itemPath}/settings/shared/${pointer(key)}`, 'Move this shared setting to each stage that consumes it.');
        }
      }

      for (const stage of stages) {
        const own = settings[stage];

        if (own === false || (stage === 'generator' && own === undefined)) {
          continue;
        }

        if (own !== undefined && !isRecord(own) && !(stage === 'generator' && own === true)) {
          report('core-stage', `${itemPath}/settings/${stage}`, 'Expected a settings object, false, or generator: true.');
          continue;
        }

        add(stage, { ...shared, ...(isRecord(own) ? own : {}) }, itemPath);
      }
    }
  }

  visit(name, []);
  const selected: Partial<Record<StageName, StageSelection>> = Object.fromEntries(stages.map(stage => [stage, false]));
  const seen = new Set<StageName>();
  let previous = -1;

  for (const entry of entries) {
    const index = stages.indexOf(entry.stage);

    if (seen.has(entry.stage)) {
      report('repeated-stage', entry.location, `Stage ${entry.stage} runs more than once. Port repeated transformations to explicit plugin steps.`);
    }

    if (index < previous) {
      report('stage-order', entry.location, 'The configured filter order differs from the fixed builder stage order. Convert the sequence to plugin hooks manually.');
    }

    previous = index;
    seen.add(entry.stage);
    selected[entry.stage] = settingsFor(entry, packs, dataPath, report);
  }

  return { stages: selected, namespaces: [...namespaces] };
}
