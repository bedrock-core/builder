import { resolveJavaModel, selectApplications } from './compiler.ts';
import type { CompileInput } from './compiler.ts';
import type { BlockStates, CheckedStates, CompiledModelSource, ModelSources } from './types.ts';

type StateValue = string | number | boolean;
export interface DefaultStates {
  javaVersion: string;
  blocks: Record<string, { properties?: Record<string, string[]>; default: number }>;
}

export interface InverseSources { schemaVersion: 1; java: string; defaults: { sha256: string } }

export interface InverseRow {
  values: StateValue[];
  java: string;
  properties: Record<string, string>;
  sources: number;
  program?: number;
  failure?: { kind: 'missing' | 'unsupported'; reason: string };
}

export interface InverseBlock { id: string; keys: string[]; domains: StateValue[][]; rows: InverseRow[] }

export interface CanonicalInverse {
  schemaVersion: 1;
  source: ModelSources;
  nativeRevision: string;
  defaults: InverseSources['defaults'];
  blocks: InverseBlock[];
}

const normalize = (value: StateValue): string | number => typeof value === 'boolean' ? Number(value) : value;
const tupleKey = (values: readonly StateValue[]): string => JSON.stringify(values.map(normalize));
const identifier = (value: string): string => `minecraft:${value.replace(/^minecraft:/, '')}`;

/** Invert the pinned forward map using Java defaults and report order to select one source per native tuple. */
export function buildInverse(input: {
  compiled: CompiledModelSource; states: CheckedStates; mappings: CompileInput['mappings'];
  blockstates: CompileInput['blockstates']; models: CompileInput['models']; defaults: DefaultStates; sources: InverseSources;
}): CanonicalInverse {
  const { compiled, states, defaults, sources } = input;

  if (compiled.source.java !== defaults.javaVersion || sources.java !== defaults.javaVersion || compiled.source.bedrock !== states.version) {
    throw new Error('Canonical mapping inputs must match the compiled Java and Bedrock versions');
  }

  const targets = new Map(states.blocks.map((block) => {
    const domains = block.keys.map((_, i) => [...new Set(block.values.map(values => values[i]))]);
    const values = new Map(block.values.map(values => [tupleKey(values), values]));

    if (values.size !== block.values.length || values.size !== domains.reduce((size, domain) => size * domain.length, 1)) {
      throw new Error(`Native state inventory is not a complete unique palette: ${block.blockId}`);
    }

    return [block.blockId, { block: { id: block.blockId, keys: block.keys, domains, rows: [] }, values, rows: new Map<string, { row: InverseRow; score: number }>() }];
  }));
  const programs = new Map(compiled.programs.map((groups, index) => [JSON.stringify(groups.map(group => compiled.groups[group].map(([model, ...application]) => [compiled.models[model].name, ...application]))), index]));
  const candidates = Object.entries(input.mappings).flatMap(([java, mapping]) => {
    const match = java.match(/^([^[]+)(?:\[(.*)\])?$/);

    if (!match) {
      throw new Error(`Invalid upstream Java state: ${java}`);
    }

    const id = identifier(match[1]), target = targets.get(identifier(mapping.bedrock_identifier ?? id));

    if (!target || target.block.keys.some(key => !Object.hasOwn(mapping.state ?? {}, key))) {
      return [];
    }

    const key = tupleKey(target.block.keys.map(key => mapping.state![key]));
    const values = target.values.get(key);

    if (!values) {
      return [];
    }

    const metadata = defaults.blocks[id] ?? defaults.blocks[id.replace(/^minecraft:/, '')];

    if (!metadata) {
      throw new Error(`Missing Java default-state metadata: ${id}`);
    }

    const axes = Object.entries(metadata.properties ?? {});
    const properties = Object.fromEntries((match[2] ?? '').split(',').filter(Boolean).map(pair => pair.split('=')));
    const defaultValues: Record<string, string> = {};
    let remainder = metadata.default;

    for (let i = axes.length - 1; i >= 0; i--) {
      const [name, domain] = axes[i];

      defaultValues[name] = domain[remainder % domain.length];
      remainder = Math.floor(remainder / domain.length);
    }

    if (remainder || !Number.isSafeInteger(metadata.default) || metadata.default < 0 || Object.keys(properties).some(name => !Object.hasOwn(defaultValues, name))) {
      throw new Error(`Invalid Java default-state metadata: ${id}`);
    }

    let order = 0, score = 0;

    for (const [name, domain] of axes) {
      properties[name] ??= defaultValues[name];
      const at = domain.indexOf(properties[name]);

      if (at < 0) {
        throw new Error(`Invalid Java source property: ${id}/${name}=${properties[name]}`);
      }

      order = order * domain.length + at;

      if (properties[name] === defaultValues[name]) {
        score++;
      }
    }

    return [{ id, properties, order, score, target, key, values }];
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.order - b.order);

  for (const candidate of candidates) {
    const { id, properties, target, key, values, score } = candidate;
    const previous = target.rows.get(key);

    if (previous && (previous.row.java !== id || previous.score >= score)) {
      previous.row.sources++;
      continue;
    }

    const row: InverseRow = { values, java: id, properties, sources: (previous?.row.sources ?? 0) + 1 };

    try {
      const definition = input.blockstates[id.replace(/^minecraft:/, '')];

      if (!definition) {
        throw new Error(`Missing Java blockstates: ${id}`);
      }

      const applications = selectApplications(definition, properties);
      const signature = JSON.stringify(applications.map(alternatives => alternatives.map(app => [app.model, app.x ?? 0, app.y ?? 0, Number(Boolean(app.uvlock)), app.weight ?? 1])));
      const program = programs.get(signature);

      if (program === undefined) {
        for (const alternatives of applications) {
          for (const app of alternatives) {
            const model = resolveJavaModel(app.model, input.models);

            if (!model.elements?.length && !/(?:^|\/)(?:air|barrier|structure_void|light)$/.test(app.model)) {
              throw new Error(`Java model requires a special renderer: ${app.model}`);
            }
          }
        }

        throw new Error('Canonical Java source requires unsupported geometry conversion');
      }

      row.program = program;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      row.failure = { kind: /^Missing Java (?:model|blockstates):/.test(reason) ? 'missing' : 'unsupported', reason };
    }

    target.rows.set(key, { row, score });
  }

  const blocks = [...targets.values()].map(target => ({ ...target.block, rows: [...target.rows.values()].map(value => value.row) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return { schemaVersion: 1, source: compiled.source, nativeRevision: states.revision, defaults: sources.defaults, blocks };
}

/** Unknown fields are ignored; omitted fields match the first compatible tuple; unmatched tuples use the first mapped tuple. */
export function createInverseMapper(inverse: CanonicalInverse): (id: string, states?: BlockStates) => { kind: 'exact' | 'fallback'; row: InverseRow } | undefined {
  const blocks = new Map(inverse.blocks.map(block => [block.id, { ...block, exact: new Map(block.rows.map(row => [tupleKey(row.values), row])) }]));

  return (id, states = {}) => {
    const block = blocks.get(id);

    if (!block?.rows.length) {
      return undefined;
    }

    const values = block.keys.map(key => states[key]);
    const row = values.every(value => value !== undefined)
      ? block.exact.get(tupleKey(values))
      : block.rows.find(row => block.keys.every((key, i) => states[key] === undefined || normalize(states[key]) === normalize(row.values[i])));

    return row ? { kind: 'exact', row } : { kind: 'fallback', row: block.rows[0] };
  };
}
