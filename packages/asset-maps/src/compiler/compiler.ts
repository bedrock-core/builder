import { closedOccluders, compileGeometry } from './geometry.ts';
import { stateKey } from './state.ts';
import type { CheckedStates, CompiledModelSource, GeyserMapping, JavaApplication, JavaBlockstate, JavaCondition, JavaModel, ModelApplication, ModelChoice, ModelCoverage, ModelMaterial, ModelSources } from './types.ts';

export interface TextureInput { path: string; method: ModelMaterial['method']; uv?: ModelMaterial['uv']; warning?: string }

export interface CompileInput {
  source: ModelSources; states: CheckedStates; mappings: Record<string, GeyserMapping>;
  models: Record<string, JavaModel>; blockstates: Record<string, JavaBlockstate>;
  texture: (javaPath: string) => TextureInput;
}

export function conditionMatches(condition: JavaCondition | undefined, values: Record<string, string>): boolean {
  return !condition || Object.entries(condition).every(([key, value]) => key === 'OR'
    ? Array.isArray(value) && value.some(part => conditionMatches(part, values))
    : key === 'AND'
      ? Array.isArray(value) && value.every(part => conditionMatches(part, values))
      : typeof value === 'string' && value.split('|').includes(values[key]));
}

export function selectApplications(block: JavaBlockstate, values: Record<string, string>): JavaApplication[][] {
  const list = (value: JavaApplication | JavaApplication[]): JavaApplication[] => Array.isArray(value) ? value : [value];

  if (block.variants) {
    const matches = Object.entries(block.variants).filter(([key]) => conditionMatches(Object.fromEntries(key.split(',').filter(Boolean).map(pair => pair.split('='))), values));

    if (matches.length !== 1) {
      throw new Error(`Expected one Java variant, received ${matches.length}`);
    }

    return [list(matches[0][1])];
  }

  if (block.multipart) {
    return block.multipart.filter(part => conditionMatches(part.when, values)).map(part => list(part.apply));
  }

  throw new Error('Missing Java blockstate definition');
}

export function resolveJavaModel(name: string, models: CompileInput['models'], cache = new Map<string, JavaModel>(), seen = new Set<string>()): JavaModel {
  name = name.replace(/^minecraft:/, '').replace(/^block\//, '');

  if (cache.has(name)) {
    return cache.get(name)!;
  }

  if (seen.has(name)) {
    throw new Error(`Cyclic Java parent: ${name}`);
  }

  const own = models[name];

  if (!own) {
    throw new Error(`Missing Java model: ${name}`);
  }

  seen.add(name);
  const parent = own.parent ? resolveJavaModel(own.parent, models, cache, seen) : {};
  const result = { ...parent, ...own, textures: { ...parent.textures, ...own.textures } };

  delete result.parent;
  seen.delete(name);
  cache.set(name, result);

  return result;
}

/** Compile semantic mappings into shared model/geometry pools and sparse mixed-radix state tables. */
export function compileModels(input: CompileInput): { data: CompiledModelSource; coverage: ModelCoverage } {
  const data: CompiledModelSource = { schemaVersion: 1, source: input.source, provider: 'minecraft:java_models', textures: [], materials: [], geometries: [], models: [], groups: [], programs: [], choices: [], blocks: [] };
  const coverage: ModelCoverage = { source: input.source, blocks: input.states.blocks.length, states: 0, mappedStates: 0, convertedStates: 0, ambiguousStates: 0, unmappedStates: 0, missingModelStates: 0, unsupportedStates: 0, geometries: 0, models: 0, textures: 0, exceptions: [] };
  const targets = new Map(input.states.blocks.map(block => [block.blockId, block]));
  const native = new Map<string, Map<string, { choices: ModelChoice[]; reasons: Set<string> }>>();
  const resolved = new Map<string, JavaModel>(), modelIds = new Map<string, number>(), failures = new Map<string, Error>();
  const geometryIds = new Map<string, number>(), materialIds = new Map<string, number>(), groupIds = new Map<string, number>(), programIds = new Map<string, number>(), choiceIds = new Map<string, number>();

  const intern = <T>(value: T, pool: T[], ids: Map<string, number>): number => {
    const key = JSON.stringify(value);

    if (!ids.has(key)) {
      ids.set(key, pool.length);
      pool.push(value);
    }

    return ids.get(key)!;
  };

  const modelId = (name: string): number => {
    if (modelIds.has(name)) {
      return modelIds.get(name)!;
    }

    if (failures.has(name)) {
      throw failures.get(name);
    }

    try {
      const model = resolveJavaModel(name, input.models, resolved);
      const invisible = /(?:^|\/)(?:air|barrier|structure_void|light)$/.test(name);

      if (!model.elements?.length && !invisible) {
        throw new Error(`Java model requires a special renderer: ${name}`);
      }

      const materials: number[] = [], warnings = new Set<string>();
      const geometry = compileGeometry(model, (symbol) => {
        const visited = new Set<string>();
        let path: string | { sprite: string; force_translucent?: boolean } = !symbol.includes('/') && Object.hasOwn(model.textures ?? {}, symbol) ? `#${symbol}` : symbol;
        let translucent = false;

        for (;;) {
          if (typeof path === 'object') {
            translucent ||= Boolean(path.force_translucent);
            path = path.sprite;
          }

          if (!path.startsWith('#')) {
            break;
          }

          if (visited.has(path)) {
            throw new Error(`Cyclic Java texture: ${path}`);
          }

          visited.add(path);
          path = model.textures?.[path.slice(1)] ?? '';
        }

        if (!path) {
          throw new Error(`Missing Java texture: ${symbol}`);
        }

        const texture = input.texture(path);
        let textureIndex = data.textures.indexOf(texture.path);

        if (textureIndex < 0) {
          textureIndex = data.textures.length;
          data.textures.push(texture.path);
        }

        if (texture.warning) {
          warnings.add(texture.warning);
        }

        const material = intern<ModelMaterial>({ texture: textureIndex, method: translucent ? 'blend' : texture.method, ...(texture.uv ? { uv: texture.uv } : {}) }, data.materials, materialIds);
        let slot = materials.indexOf(material);

        if (slot < 0) {
          slot = materials.length;
          materials.push(material);
        }

        return slot;
      });

      if (geometry.faces.some(face => face[14] >= 0)) {
        warnings.add('Biome/state tint uses a default sample colour');
      }

      const geometryIndex = intern(geometry, data.geometries, geometryIds);
      const occluders = closedOccluders(geometry, slot => data.materials[materials[slot]].method === 'opaque');
      const index = data.models.length;

      data.models.push({ name, geometry: geometryIndex, materials, occluders, ...(warnings.size ? { warnings: [...warnings] } : {}) });
      modelIds.set(name, index);

      return index;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      failures.set(name, failure);
      throw failure;
    }
  };

  for (const [java, mapping] of Object.entries(input.mappings)) {
    const match = java.match(/^([^[]+)(?:\[(.*)\])?$/);

    if (!match) {
      throw new Error(`Invalid upstream Java state: ${java}`);
    }

    const javaId = match[1], properties = Object.fromEntries((match[2] ?? '').split(',').filter(Boolean).map(pair => pair.split('=')));
    const bedrock = `minecraft:${(mapping.bedrock_identifier ?? javaId).replace(/^minecraft:/, '')}`, target = targets.get(bedrock), states = mapping.state ?? {};

    if (!target || target.keys.some(key => !Object.hasOwn(states, key))) {
      continue;
    }

    let table = native.get(bedrock);

    if (!table) {
      table = new Map();
      native.set(bedrock, table);
    }

    const key = stateKey(target.keys, states), entry = table.get(key) ?? { choices: [], reasons: new Set<string>() };

    table.set(key, entry);

    try {
      const definition = input.blockstates[javaId.replace(/^minecraft:/, '')];

      if (!definition) {
        throw new Error(`Missing Java blockstates: ${javaId}`);
      }

      const groups = selectApplications(definition, properties).map(alternatives => intern(alternatives.map((app): ModelApplication => {
        if ((app.x ?? 0) % 90 || (app.y ?? 0) % 90 || (app.weight ?? 1) <= 0) {
          throw new Error('Invalid Java blockstate application');
        }

        return [modelId(app.model), app.x ?? 0, app.y ?? 0, Number(Boolean(app.uvlock)), app.weight ?? 1];
      }), data.groups, groupIds));
      const program = intern(groups, data.programs, programIds);
      const extra = Object.fromEntries(Object.entries(states).filter(([key]) => !target.keys.includes(key)).sort(([a], [b]) => a.localeCompare(b)));

      if (!entry.choices.some(choice => choice.program === program && JSON.stringify(choice.extra) === JSON.stringify(extra))) {
        entry.choices.push({ program, extra, java: javaId, ...(properties.facing ? { facing: properties.facing } : {}) });
      }
    } catch (error) { entry.reasons.add(error instanceof Error ? error.message : String(error)); }
  }

  for (const block of input.states.blocks) {
    const domains = block.keys.map((_, i) => [...new Set(block.values.map(values => values[i]))]);
    const indices: number[] = [], choices: number[] = [], reasons = new Set<string>();
    let mapped = 0, converted = 0, ambiguous = 0, unmapped = 0, missingModels = 0, unsupported = 0;

    for (const values of block.values) {
      coverage.states++;
      const state = Object.fromEntries(block.keys.map((key, i) => [key, values[i]]));
      const entry = native.get(block.blockId)?.get(stateKey(block.keys, state));

      if (!entry) {
        unmapped++;
        reasons.add('No upstream mapping for this Bedrock permutation');
        continue;
      }

      mapped++;

      for (const reason of entry.reasons) {
        reasons.add(reason);
      }

      if (!entry.choices.length) {
        if (entry.reasons.size && [...entry.reasons].every(reason => /^Missing Java (?:model|blockstates):/.test(reason))) {
          missingModels++;
        } else { unsupported++; }

        continue;
      }

      converted++;

      if (new Set(entry.choices.map(choice => choice.program)).size > 1) {
        ambiguous++;
      }

      indices.push(values.reduce<number>((index, value, i) => index * domains[i].length + domains[i].indexOf(value), 0));
      choices.push(intern(entry.choices, data.choices, choiceIds));
    }

    const connection = block.blockId.endsWith('_fence') ? 'fence' : block.blockId.endsWith('_wall') ? 'wall' : block.blockId.endsWith('_pane') || block.blockId === 'minecraft:iron_bars' ? 'pane' : undefined;

    if (indices.length) {
      data.blocks.push({ id: block.blockId, keys: block.keys, domains, indices, choices, ...(connection ? { connect: connection } : {}) });
    }

    coverage.mappedStates += mapped;
    coverage.convertedStates += converted;
    coverage.ambiguousStates += ambiguous;
    coverage.unmappedStates += unmapped;
    coverage.missingModelStates += missingModels;
    coverage.unsupportedStates += unsupported;

    if (converted !== block.values.length || ambiguous || reasons.size) {
      coverage.exceptions.push({ blockId: block.blockId, total: block.values.length, converted, ambiguous, unmapped, missingModels, unsupported, reasons: [...reasons].sort() });
    }
  }

  coverage.geometries = data.geometries.length;
  coverage.models = data.models.length;
  coverage.textures = data.textures.length;

  return { data, coverage };
}
