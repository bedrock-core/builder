import { validateConfig } from './config.ts';
import type { BuildProfile } from './config.ts';
import { planBuild } from './plan.ts';
import { convertExport } from './migration/exports.ts';
import { convertFilters } from './migration/filters.ts';
import { isRecord, pointer } from './migration/types.ts';
import type { MigrationOptions, MigrationResult, ReportDiagnostic } from './migration/types.ts';

export type { FilterKind, MigrationDiagnostic, MigrationOptions, MigrationResult } from './migration/types.ts';
export { migrateRegolithProject, writeMigration } from './migration/project.ts';
export type { ProjectMigration } from './migration/project.ts';

/**
 * Produce a reviewable config and diagnostics without evaluating or executing filters.
 * @param input Source data accepted by this operation.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns A configuration preview, conversion diagnostics and readiness flag.
 * @remarks Filters, shell commands and expressions are not executed. This operation converts configuration, not project code or pack manifests.
 */
export function migrateRegolithConfig(input: unknown, options: MigrationOptions = {}): MigrationResult {
  const config = isRecord(input) ? structuredClone(input) : {};
  const diagnostics: MigrationResult['diagnostics'] = [];
  const metadata = ['$schema', 'targetVersion', 'namespace', 'name', 'description', 'authors'];

  const report: ReportDiagnostic = (code, location, message, severity = 'error') => {
    if (!diagnostics.some(item => item.code === code && item.path === location && item.message === message)) {
      diagnostics.push({ severity, code, path: location, message });
    }
  };

  const result = (): MigrationResult => ({
    config: Object.fromEntries([
      ...metadata.filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]]),
      ...Object.entries(config).filter(([key]) => !metadata.includes(key)),
    ]),
    diagnostics,
    ready: !diagnostics.some(item => item.severity === 'error'),
  });

  if (!isRecord(input) || !isRecord(config.regolith)) {
    report('regolith-required', '/regolith', 'Expected a Regolith project configuration.');

    return result();
  }

  if (Object.hasOwn(config, 'bedrockCore')) {
    report('existing-builder', '/bedrockCore', 'Builder configuration already exists. Merge profiles manually; migration never overwrites it.');

    return result();
  }

  const regolith = config.regolith;

  if (!['1.4.0', '1.8.0'].includes(String(regolith.formatVersion))) {
    report('regolith-version', '/regolith/formatVersion', 'Supported source formats are 1.4.0 and 1.8.0. Older or unknown export semantics need manual conversion.');
  }

  for (const key of Object.keys(regolith)) {
    if (!['formatVersion', 'profiles', 'filterDefinitions', 'dataPath', 'watchPaths'].includes(key)) {
      report('regolith-property', `/regolith/${pointer(key)}`, 'This Regolith property has no verified builder equivalent.');
    }
  }

  if (!isRecord(regolith.profiles) || !Object.keys(regolith.profiles).length) {
    report('profiles-required', '/regolith/profiles', 'Expected at least one Regolith profile.');

    return result();
  }

  const packs: Record<string, string> = {};

  if (isRecord(config.packs)) {
    for (const [id, directory] of Object.entries(config.packs)) {
      if (typeof directory === 'string' && directory.trim()) {
        Object.defineProperty(packs, id, { value: directory, enumerable: true, configurable: true, writable: true });
      }
    }
  }

  const profiles = regolith.profiles;
  const definitions = isRecord(regolith.filterDefinitions) ? regolith.filterDefinitions : {};
  const selectedNames = options.profiles ?? Object.keys(profiles);
  const namespaces = new Set<string>();
  const migrated: [string, BuildProfile][] = [];

  if (!selectedNames.length || new Set(selectedNames).size !== selectedNames.length) {
    report('profile-selection', '/regolith/profiles', 'Select at least one distinct profile.');
  }

  for (const name of Object.keys(options.exports ?? {})) {
    if (!selectedNames.includes(name)) {
      report('export-profile', '/regolith/profiles', `Export override refers to an unselected profile: ${name}.`);
    }
  }

  for (const name of selectedNames) {
    const source = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    const location = `/regolith/profiles/${pointer(name)}`;

    if (!isRecord(source)) {
      report('profile-selection', location, 'Selected profile must exist and be an object.');
      continue;
    }

    const converted = convertFilters(name, profiles, definitions, packs, regolith.dataPath, options, report);

    for (const namespace of converted.namespaces) {
      namespaces.add(namespace);
    }

    const profile: BuildProfile = { stages: converted.stages };
    const destinations = convertExport(source.export, packs, config.name, name, options, report, `${location}/export`);

    if (destinations) {
      profile.export = destinations;
    }

    if (regolith.watchPaths !== undefined) {
      if (Array.isArray(regolith.watchPaths) && regolith.watchPaths.every(value => typeof value === 'string' && value.trim())) {
        profile.watch = { paths: [...regolith.watchPaths] };
      } else {
        report('watch-paths', '/regolith/watchPaths', 'watchPaths must be an array of nonempty strings.');
      }
    }

    migrated.push([name, profile]);
  }

  delete config.type;
  config.authors ??= typeof config.author === 'string' || isRecord(config.author) ? [config.author] : [];

  if (Object.hasOwn(config, 'author')) {
    if (Array.isArray(config.authors) && !config.authors.some(author => JSON.stringify(author) === JSON.stringify(config.author))) {
      report('author-metadata', '/author', 'Keeping the existing authors list; the singular author field is removed.', 'warning');
    }

    delete config.author;
  }

  delete config.worlds;
  config.targetVersion = options.targetVersion ?? config.targetVersion;
  config.namespace = options.namespace ?? config.namespace ?? (namespaces.size === 1 ? [...namespaces][0] : undefined);

  if (config.targetVersion === undefined) {
    report('target-version', '/targetVersion', 'Set targetVersion or pass --target-version with the intended Minecraft version.');
  }

  if (config.namespace === undefined) {
    report('namespace', '/namespace', 'Set namespace or pass --namespace; stage namespaces must agree for automatic inference.');
  }

  config.$schema = options.schema ?? new URL('../schemas/config.schema.json', import.meta.url).href;
  config.bedrockCore = { formatVersion: '1.0.0', profiles: Object.fromEntries(migrated) };

  try {
    const validated = validateConfig(config);

    for (const name of selectedNames) {
      if (Object.hasOwn(validated.bedrockCore.profiles, name)) {
        planBuild(validated, name);
        const destinations = validated.bedrockCore.profiles[name].export;

        if (destinations) {
          const sourceIds = Object.keys(packs).sort();
          const outputIds = Object.keys(destinations).sort();

          if (JSON.stringify(sourceIds) !== JSON.stringify(outputIds)) {
            report('export-packs', `/bedrockCore/profiles/${pointer(name)}/export`, 'Each configured pack needs exactly one destination; unknown pack IDs are invalid.');
          }
        }
      }
    }
  } catch (error) {
    report('builder-config', '/bedrockCore', error instanceof Error ? error.message : String(error));
  }

  return result();
}
