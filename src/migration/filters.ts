import type { NodePluginDefinition, PluginStep } from '../config.ts';
import type { ReportDiagnostic } from './types.ts';
import { isRecord, pointer } from './types.ts';

/** Flatten profile references into ordered steps for standalone Node filters. */
export function convertFilters(
  name: string,
  profiles: Record<string, unknown>,
  definitions: Record<string, unknown>,
  plugins: Map<string, NodePluginDefinition>,
  dataPath: string | undefined,
  report: ReportDiagnostic,
): PluginStep[] {
  const steps: PluginStep[] = [];
  let remaining = 10000;

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
        report('shell-commands', `${location}/${key}`, 'Move shell commands and environment setup into a Node step or a Builder plugin.');
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
        report('filter-condition', `${itemPath}/when`, 'Conditional execution needs separate profiles or a Builder plugin.');
        continue;
      }

      for (const key of Object.keys(item)) {
        if (!['filter', 'profile', 'settings', 'disabled', 'when', 'arguments', 'extraArguments'].includes(key)) {
          report(key === 'asyncFilters' ? 'parallel-filters' : 'filter-property', `${itemPath}/${pointer(key)}`, 'This filter property needs manual conversion. Builder file transformations are sequential.');
        }
      }

      const args = item.arguments;

      if (args !== undefined && (!Array.isArray(args) || !args.every(value => typeof value === 'string'))) {
        report('filter-arguments', `${itemPath}/arguments`, 'Filter arguments must be an array of strings.');
        continue;
      }

      if (item.extraArguments !== undefined && item.extraArguments !== 'ignore') {
        report('extra-arguments', `${itemPath}/extraArguments`, 'Runtime argument forwarding needs manual conversion.');
      }

      if (typeof item.profile === 'string' && item.filter === undefined) {
        if (item.settings !== undefined || args?.length) {
          report('profile-settings', itemPath, 'Settings and arguments on profile references need manual conversion.');
        }

        visit(item.profile, [...parents, profileName]);
        continue;
      }

      if (typeof item.filter !== 'string' || item.profile !== undefined) {
        report('filter-entry', itemPath, 'Use exactly one filter or profile reference.');
        continue;
      }

      const id = item.filter;
      const definition = Object.hasOwn(definitions, id) ? definitions[id] : undefined;
      const definitionPath = `/regolith/filterDefinitions/${pointer(id)}`;

      if (!isRecord(definition) || definition.url !== undefined || definition.npm !== undefined) {
        report('custom-filter', itemPath, `Provide a local Node entry for ${id} or configure its Builder step manually.`);
        continue;
      }

      if (definition.runWith !== 'nodejs') {
        report('filter-runtime', definitionPath, 'Automatic conversion supports local NodeJS filters.');
        continue;
      }

      if (typeof definition.script !== 'string' || !definition.script.trim()) {
        report('filter-script', `${definitionPath}/script`, 'Provide the path to the local Node entry.');
        continue;
      }

      for (const key of Object.keys(definition)) {
        if (!['runWith', 'script', 'requirements'].includes(key)) {
          report('filter-definition', `${definitionPath}/${pointer(key)}`, 'This filter definition property needs manual conversion.');
        }
      }

      if (typeof definition.requirements === 'string' && definition.requirements.trim()) {
        report('filter-requirements', `${definitionPath}/requirements`, `Install the filter dependencies in ${definition.requirements} before building.`, 'warning');
      } else if (definition.requirements !== undefined) {
        report('filter-requirements', `${definitionPath}/requirements`, 'Provide the directory containing the Node filter dependencies.');
      }

      if (item.settings !== undefined && !isRecord(item.settings)) {
        report('filter-settings', `${itemPath}/settings`, 'Filter settings must be an object.');
        continue;
      }

      plugins.set(id, { script: definition.script, ...(dataPath === undefined ? {} : { dataPath }) });
      steps.push({
        plugin: id,
        after: 'prepare',
        ...(item.settings === undefined ? {} : { settings: item.settings }),
        ...(args === undefined ? {} : { arguments: args }),
      });
    }
  }

  visit(name, []);

  return steps;
}
