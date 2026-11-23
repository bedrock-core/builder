import type { BlockStates, CompiledModelSource, ModelApplication, PackedFace, Vector3 } from '../compiler/types.ts';
import type { CanonicalInverse, InverseBlock, InverseRow } from '../compiler/inverse.ts';
import type { FaceTexture, TextureBindings } from '../compiler/textures.ts';
import type { RendererInputs } from '../sources/types.ts';
import type { AtlasEntry, Bindings, Components, Coverage, Cube, GenerationSummary, GeometryContext, Material, Problem, Resources, StateValue, Side } from './types.ts';
import { asError, isRecord } from '../json.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { nativeAssets } from './native.ts';
import { supplementBlockModels } from './supplements.ts';
import { parsePackJson } from '../sources/pack.ts';
import { serializeJson } from '../json.ts';
import { availableName, nameGeometries, namePart } from './names.ts';
import { createRendererAdapters } from './renderers.ts';
import { applyBlockRotation } from '../compiler/geometry.ts';
import { createInverseMapper } from '../compiler/inverse.ts';
import { remapFaceTexture } from '../compiler/textures.ts';

type RenderRow = Pick<InverseRow, 'values'> & Partial<InverseRow>;
type Slot = { binding: Material; sides: Set<Side>; slot?: string };
interface ExportOptions { inverse?: CanonicalInverse; textures?: TextureBindings; renderers?: RendererInputs; minecraft?: string; definitions?: Resources }

interface WriteOptions { documents: Resources; coverage: Coverage; sourceLock: { minecraft: string }; licenses: Record<string, Buffer>; output?: string; check?: boolean; pretty?: boolean }

import { distribution } from '../paths.ts';
const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const round = (value: number): number => Math.abs(value) < 1e-8 ? 0 : Math.round(value * 1e8) / 1e8;
const triple = (value: Vector3): number[] => [value.x, value.y, value.z];
const sides = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
const vector = (values: number[]): Vector3 => ({ x: values[0], y: values[1], z: values[2] });
const cross = (a: Vector3, b: Vector3): Vector3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const paths = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(paths) : isRecord(value) ? ['textures', 'path', 'variations'].flatMap(key => paths(value[key])) : [];

/** Encode one orthogonal textured quad as a native cube face, retaining its UV axes. */
export function faceCube(face: PackedFace, slot: string): Cube {
  const [ox, oy, oz, ux, uy, uz, vx, vy, vz, tx, ty, tw, th] = face;
  const width = Math.hypot(ux, uy, uz) * 16, height = Math.hypot(vx, vy, vz) * 16;

  if (!width || !height) {
    throw new Error('A native face must have nonzero edges');
  }

  const x = vector([-ux * 16 / width, -uy * 16 / width, uz * 16 / width]);
  const y = vector([-vx * 16 / height, -vy * 16 / height, vz * 16 / height]);

  if (Math.abs(x.x * y.x + x.y * y.y + x.z * y.z) > 1e-6) {
    throw new Error('A native face must have orthogonal edges');
  }

  const z = cross(x, y);
  const rotation = Math.hypot(x.x, x.y) < 1e-8
    ? [Math.atan2((x.z < 0 ? 1 : -1) * y.x, (x.z < 0 ? 1 : -1) * z.x), (x.z < 0 ? 1 : -1) * Math.PI / 2, 0]
    : [Math.atan2(y.z, z.z), Math.atan2(-x.z, Math.hypot(x.x, x.y)), Math.atan2(x.y, x.x)];
  const center = [(ox + (ux + vx) / 2 - 0.5) * 16, (oy + (uy + vy) / 2) * 16, (0.5 - oz - (uz + vz) / 2) * 16];

  return { origin: [center[0] - width / 2, center[1] - height / 2, center[2]].map(round), size: [width, height, 0].map(round),
    pivot: center.map(round), rotation: rotation.map(value => round(value * 180 / Math.PI)),
    uv: { north: { uv: [(tx + tw) * 16, (ty + th) * 16].map(round), uv_size: [-tw * 16, -th * 16].map(round), material_instance: slot } } };
}

function rotatedFace(face: PackedFace, application: ModelApplication): number[] {
  if (!application[1] && !application[2]) {
    return face;
  }

  const transformed = applyBlockRotation({ origin: vector(face.slice(0, 3)), u: vector(face.slice(3, 6)), v: vector(face.slice(6, 9)), uv: [face[9], face[10], face[11], face[12]], texture: 0 }, sides[face[16]], application[1], application[2], !!application[3]);

  return [...triple(transformed.origin), ...triple(transformed.u), ...triple(transformed.v), ...transformed.uv, ...face.slice(13)];
}

const condition = (states: BlockStates): string => Object.entries(states).map(([key, value]) => {
  if (key.includes('\'') || (typeof value === 'string' && (value.includes('\'') || value.includes('\\')))) {
    throw new Error('Block state cannot be represented as a Molang literal');
  }

  return `q.block_state('${key}') == ${typeof value === 'string' ? '\'' + value + '\'' : typeof value === 'boolean' ? Number(value) : value}`;
}).join(' && ') || '1';

const stateAt = (block: Pick<InverseBlock, 'keys' | 'domains'>, index: number): Record<string, StateValue> => {
  const result: Record<string, StateValue> = {};

  for (let i = block.keys.length - 1; i >= 0; i--) {
    result[block.keys[i]] = block.domains[i][index % block.domains[i].length];
    index = Math.floor(index / block.domains[i].length);
  }

  return Object.fromEntries(block.keys.map(key => [key, result[key]]));
};

const yaw = (application: ModelApplication): number => (application[2] % 360 + 360) % 360;
const applicationShape = (application: ModelApplication): string => JSON.stringify([application[0], application[1], application[3]]);

const baseApplication = (alternatives: ModelApplication[]): ModelApplication => {
  if (!alternatives?.length) {
    throw new Error('Model application group is empty');
  }

  if (new Set(alternatives.map(applicationShape)).size === 1) {
    return alternatives.reduce((base, application) => yaw(application) < yaw(base) ? application : base);
  }

  return [...alternatives].sort((a, b) => b[4] - a[4] || a[0] - b[0] || a[1] - b[1] || yaw(a) - yaw(b) || a[3] - b[3])[0];
};

/** Generate supplement documents only; upstream definitions and private tables are never copied. */
export function supplementDocuments(compiled: CompiledModelSource, resources: Resources, bindings: Bindings, { inverse, textures, renderers, minecraft = compiled.source.bedrock, definitions = new Map() }: ExportOptions = {}): { files: Resources; coverage: Coverage } {
  if (!inverse) {
    throw new Error('Canonical inverse mappings are required to export native models');
  }

  const resolveSource = createInverseMapper(inverse);
  const native = nativeAssets(resources, { target: minecraft, bindings: { blocks: bindings.blocks } });
  const files: Resources = new Map(), gaps: Problem[] = [], issues: Problem[] = [], approximations: Coverage['approximations'] = [], fallbacks: Coverage['fallbacks'] = [], aliases: Record<string, AtlasEntry> = {}, itemAliases: Record<string, AtlasEntry> = {};
  const metadata = resources.get('metadata/mojang-blocks.json');
  const nativeBlocks = new Map((metadata?.data_items ?? []).map(block => [block.name, new Set((block.properties ?? []).map(property => property.name))]));
  const nativeStates = new Map((metadata?.block_properties ?? []).map(property => [property.name, property.values.map(value => value.value)]));
  const nativePaths = new Set([...Object.values(native.textures).flatMap(texture => texture.paths), ...textures?.paths ?? [], ...Object.keys(textures?.images ?? {})]);
  const terrain = resources.get('textures/terrain_texture.json')?.texture_data ?? {};
  const itemTerrain = resources.get('textures/item_texture.json')?.texture_data ?? {};

  const aliasesByPath = (source: Record<string, AtlasEntry>): Map<string, string> => {
    const result = new Map<string, string>();

    for (const [alias, entry] of Object.entries(source).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const selected = paths(entry);

      if (selected.length === 1 && (!result.has(selected[0]) || alias === selected[0].split('/').at(-1))) {
        result.set(selected[0], alias);
      }
    }

    return result;
  };

  const aliasByPath = aliasesByPath(terrain), itemAliasByPath = aliasesByPath(itemTerrain);
  const reservedAliases = (source: Record<string, AtlasEntry>, file: string): Set<string> => new Set([...Object.keys(source), ...Object.keys(definitions.get('resource_pack/textures/' + file)?.texture_data ?? {})]);
  const terrainNames = reservedAliases(terrain, 'terrain_texture.json'), itemNames = reservedAliases(itemTerrain, 'item_texture.json');
  const format = minecraft.split('.').slice(0, 3).join('.');
  const fail = (kind: string, id: string, reason: string, states?: BlockStates): number => issues.push({ kind, id, reason, ...(states ? { states } : {}) });

  const textureAlias = (path: string): string => {
    if (!nativePaths.has(path)) {
      throw new Error('Texture is absent from upstream declarations: ' + path);
    }

    if (aliasByPath.has(path)) {
      return aliasByPath.get(path)!;
    }

    const alias = availableName('bedrock_core_asset_maps_' + namePart(path.replace(/^textures\//, '')), terrainNames);

    aliases[alias] = { textures: path };
    aliasByPath.set(path, alias);

    return alias;
  };

  const notes = new Map<string, Set<string>>();

  const note = (id: string, reason: string): void => {
    if (!notes.has(id)) {
      notes.set(id, new Set());
    }

    notes.get(id)!.add(reason);
  };

  const adapters = createRendererAdapters({ inputs: renderers, compiled, textures, native, files, faceCube, rotateFace: rotatedFace, textureAlias, note });
  const programs = new Map<number, Components | Error>();

  const nativeCube = (block: InverseBlock, index: number): Components | undefined => {
    const texture = native.blocks[block.id]?.textures, groups = compiled.programs[index];

    if (!texture || groups.length !== 1) {
      return undefined;
    }

    const applications = compiled.groups[groups[0]];

    if (typeof texture !== 'string' && (applications.some(value => value[1] || value[2]) || sides.some(side => typeof (texture[side] ?? texture.side ?? texture['*']) !== 'string'))) {
      return undefined;
    }

    const methods = new Set(applications.flatMap(application => compiled.models[application[0]].materials.map(index => compiled.materials[index].method)));

    if (methods.size !== 1) {
      return undefined;
    }

    if (!applications.every((application) => {
      const geometry = compiled.geometries[compiled.models[application[0]].geometry];

      return geometry.faces.length === 6 && geometry.boxes.length === 1 && geometry.boxes[0].sides === 63 && geometry.boxes[0].bounds.every((value, i) => value === (i < 3 ? 0 : 1));
    })) { return undefined; }

    const render_method = ({ opaque: 'opaque', cutout: 'alpha_test', blend: 'blend' } as Record<string, string>)[[...methods][0]];

    return { 'minecraft:geometry': 'minecraft:geometry.full_block', 'minecraft:material_instances': typeof texture === 'string'
      ? { '*': { texture, render_method } }
      : Object.fromEntries(sides.map(side => [side, { texture: texture[side] ?? texture.side ?? texture['*'], render_method }])) };
  };

  const program = (index: number): Components | Error => {
    if (programs.has(index)) {
      return programs.get(index)!;
    }

    try {
      const faces: { face: PackedFace; entry: Slot }[] = [], materials: Record<string, Material> = {}, slots = new Map<string, Slot>();

      for (const group of compiled.programs[index]) {
        const alternatives = compiled.groups[group];
        const application = baseApplication(alternatives);
        const model = compiled.models[application[0]];

        for (const [i, face] of compiled.geometries[model.geometry].faces.entries()) {
          const material = compiled.materials[model.materials[face[13]]];
          const resolved = textures?.models[model.name]?.[i];

          if (resolved?.error) {
            throw new Error(`No verified native texture binding for ${resolved.source}: ${resolved.error}`);
          }

          const path = resolved?.path ?? compiled.textures[material.texture];

          if (path === 'textures/physics_models/java_blocks') {
            throw new Error('A Java atlas texture has no verified native binding');
          }

          const uv = material.uv, animation = native.textures[path]?.flipbook;
          const selection: FaceTexture = resolved ?? { source: path, transform: uv && !animation ? [uv[0], uv[1], uv[2], 0, 0, uv[3]] : [0, 0, 1, 0, 0, 1] };
          const mapped = remapFaceTexture(rotatedFace(face, application), selection);
          const binding = { texture: textureAlias(path), render_method: ({ opaque: 'opaque', cutout: 'alpha_test_single_sided', blend: 'blend' } as Record<string, string>)[resolved?.method ?? material.method] };

          if (!binding.render_method) {
            throw new Error('Unsupported native render method: ' + material.method);
          }

          const key = JSON.stringify(binding);

          if (!slots.has(key)) {
            slots.set(key, { binding, sides: new Set<Side>() });
          }

          const entry = slots.get(key)!;

          entry.sides.add(sides[face[16]]);
          faces.push({ face: mapped, entry });
        }
      }

      const used = new Set<string>();

      for (const entry of slots.values()) {
        const selected = sides.filter(side => entry.sides.has(side));
        const role = selected.length === 6
          ? 'all'
          : selected.join(',') === 'north,south,east,west'
            ? 'side'
            : selected.join(',') === 'up,down'
              ? 'end'
              : selected.map(side => ({ up: 'top', down: 'bottom' } as Record<string, string>)[side] ?? side).join('_') || 'surface';

        entry.slot = availableName(role, used);
        materials[entry.slot] = entry.binding;
      }

      const cubes = faces.map(({ face, entry }) => faceCube(face, entry.slot!));
      const key = hash(cubes).slice(0, 24), identifier = 'geometry.bedrock_core.asset_maps.' + key;
      const file = `resource_pack/models/blocks/${key}.geo.json`;

      if (!files.has(file)) {
        files.set(file, { 'format_version': '1.16.0', 'minecraft:geometry': [{ description: { identifier, texture_width: 16, texture_height: 16 }, bones: [{ name: 'root', cubes }] }] });
      }

      const result = { 'minecraft:geometry': identifier, 'minecraft:material_instances': Object.keys(materials).length ? materials : { '*': { texture: 'stone', render_method: 'opaque' } } };

      programs.set(index, result);

      return result;
    } catch (error) {
      const failure = asError(error);

      programs.set(index, failure);

      return failure;
    }
  };

  let mappedStates = 0, sourceStates = 0;
  const contexts = new Map<string, GeometryContext[]>();

  for (const block of inverse.blocks) {
    const capacity = block.domains.reduce((size, domain) => size * domain.length, 1);

    sourceStates += capacity;

    if (metadata) {
      const keys = nativeBlocks.get(block.id);

      if (!keys) {
        throw new Error('Not a vanilla Bedrock block: ' + block.id);
      }

      if (block.keys.some(key => !keys.has(key))) {
        throw new Error('State keys differ from vanilla Bedrock: ' + block.id);
      }

      for (const [i, key] of block.keys.entries()) {
        const values = nativeStates.get(key);

        if (!values || block.domains[i].some(value => !values.includes(value))) {
          throw new Error('State values differ from vanilla Bedrock: ' + block.id + '/' + key);
        }
      }
    }

    const original = native.blocks[block.id]?.['minecraft:block'];

    if (original?.components?.['minecraft:geometry'] !== undefined) {
      continue;
    }

    if (!block.rows.length && !adapters.supports(block.id)) {
      gaps.push({ kind: 'block', id: block.id, reason: 'No Java source is mapped to this native Bedrock block', missingStates: capacity,
        stateTuples: Array.from({ length: capacity }, (_, i) => stateAt(block, i)) });
      continue;
    }

    const useNative = adapters.supportsNative(block.id);
    const rows: RenderRow[] = !useNative && block.rows.length ? block.rows : Array.from({ length: capacity }, (_, i) => ({ values: block.keys.map(key => stateAt(block, i)[key]) }));
    const selections = new Map(rows.map((row) => {
      let selected = useNative
        ? adapters.nativeBlock(block.id, Object.fromEntries(block.keys.map((key, i) => [key, row.values[i]])))
        : row.program === undefined ? new Error(row.failure?.reason ?? 'Mapped Java model geometry is missing') : nativeCube(block, row.program) ?? program(row.program);

      if (!useNative && selected instanceof Error) {
        try {
          selected = adapters.block(block.id, Object.fromEntries(block.keys.map((key, i) => [key, row.values[i]])), row) ?? selected;
        } catch (error) { selected = asError(error); }
      }

      if (!(selected instanceof Error) && row.program !== undefined && compiled.programs[row.program].some(group => compiled.groups[group].length > 1)) {
        note(block.id, 'Weighted model variants use a deterministic representative; coordinate-based variation requires runtime selection.');
      }

      return [row, selected!];
    }));
    const rendered: { states: BlockStates; components: Components | Error; signature: string }[] = [];
    const failures = new Map<RenderRow, Problem & { affectedStates: number; stateTuples: BlockStates[] }>();
    let fallbackStates = 0, renderedFallbacks = 0;

    for (let i = 0; i < capacity; i++) {
      const states = stateAt(block, i), selection = !useNative && block.rows.length ? resolveSource(block.id, states)! : { kind: 'exact', row: rows[i] }, components = selections.get(selection.row)!;

      if (selection.kind === 'fallback') {
        fallbackStates++;
      }

      const signature = components instanceof Error ? 'unavailable' : JSON.stringify(components);

      rendered.push({ states, components, signature });

      if (components instanceof Error) {
        const previous = failures.get(selection.row);

        if (previous) {
          previous.affectedStates++;
          previous.stateTuples.push(states);
        } else {
          failures.set(selection.row, { kind: 'block', id: block.id, reason: components.message,
            states: Object.fromEntries(block.keys.map((key, i) => [key, selection.row.values[i]])), affectedStates: 1, stateTuples: [states] });
        }

        continue;
      }

      if (selection.kind === 'fallback') {
        renderedFallbacks++;
      }

      if (!contexts.has(block.id)) {
        contexts.set(block.id, []);
      }

      contexts.get(block.id)!.push({ identifier: typeof components['minecraft:geometry'] === 'string' ? components['minecraft:geometry'] : components['minecraft:geometry']!.identifier, states });
      mappedStates++;
    }

    for (const [row, failure] of failures) {
      (row.failure?.kind === 'missing' ? gaps : issues).push(failure);
    }

    if (fallbackStates) {
      fallbacks.push({ kind: 'block', id: block.id, affectedStates: fallbackStates, renderedStates: renderedFallbacks, reason: 'Unmatched native tuples use the first mapped state' });
    }

    // Retain only native fields whose removal would change the selected render components.
    let renderKeys = [...block.keys];

    for (const key of [...renderKeys].reverse()) {
      const remaining = renderKeys.filter(value => value !== key), signatures = new Map();

      if (rendered.every((row) => {
        const tuple = JSON.stringify(remaining.map(key => row.states[key]));

        if (signatures.has(tuple)) {
          return signatures.get(tuple) === row.signature;
        }

        signatures.set(tuple, row.signature);

        return true;
      })) { renderKeys = remaining; }
    }

    const complete = failures.size === 0, selectedBase = complete ? selections.get(rows[0]) : undefined;
    const base = selectedBase instanceof Error ? undefined : selectedBase;
    const baseSignature = base ? JSON.stringify(base) : undefined, byComponents = new Map<string, { components: Components; conditions: Set<string> }>();

    for (const row of rendered) {
      if (row.components instanceof Error || row.signature === baseSignature) {
        continue;
      }

      if (!byComponents.has(row.signature)) {
        byComponents.set(row.signature, { components: row.components, conditions: new Set() });
      }

      byComponents.get(row.signature)!.conditions.add(condition(Object.fromEntries(renderKeys.map(key => [key, row.states[key]]))));
    }

    const permutations = [...byComponents.values()].map(value => ({ condition: [...value.conditions].map(value => '(' + value + ')').join(' || '), components: value.components }));

    if (base || permutations.length) {
      files.set(`behavior_pack/blocks/${block.id.replace(':', '/')}.json`, { 'format_version': format, 'minecraft:block': {
        description: { identifier: block.id, ...(permutations.length && renderKeys.length ? { states: Object.fromEntries(block.keys.flatMap((key, i) => renderKeys.includes(key) ? [[key, block.domains[i]]] : [])) } : {}) },
        components: base ?? {}, ...(permutations.length ? { permutations } : {}),
      } });
    }
  }

  adapters.entities();
  nameGeometries(files, contexts);

  for (const [id, source] of Object.entries(bindings.blocks ?? {})) {
    if (native.blocks[id]?.['minecraft:block'].components?.['minecraft:geometry'] !== undefined) {
      continue;
    }

    const textures = native.blocks[source]?.textures;

    if (!textures) {
      fail('block', id, 'The legacy texture binding has no upstream source');
      continue;
    }

    if (!files.has(`behavior_pack/blocks/${id.replace(':', '/')}.json`)) {
      fail('block', id, 'The legacy texture alias requires an authored geometry mapping');
    }
  }

  const upstreamBlocks = new Set(Object.entries(native.blocks).filter(([, value]) => value['minecraft:block'].components?.['minecraft:geometry'] !== undefined).map(([id]) => id));

  supplementBlockModels(native);

  for (const [id, block] of Object.entries(native.blocks)) {
    if (files.has(`behavior_pack/blocks/${id.replace(':', '/')}.json`)) {
      continue;
    }

    const geometry = block['minecraft:block'].components?.['minecraft:geometry'];
    const model = native.models[typeof geometry === 'string' ? geometry : geometry?.identifier ?? ''];

    if (model?.provenance?.kind !== 'supplemental') {
      continue;
    }

    const identifier = model.geometry.description.identifier;

    files.set('resource_pack/models/blocks/closed_chest.geo.json', { 'format_version': '1.16.0', 'minecraft:geometry': [model.geometry] });
    const bindings = typeof block.textures === 'string' ? { '*': block.textures } : block.textures!;
    const materials = Object.fromEntries(sides.map(side => [side, { texture: bindings[side] ?? bindings.side ?? bindings['*'], render_method: 'opaque' }]));

    if (Object.values(materials).some(material => !material.texture)) {
      fail('block', id, 'Closed chest textures do not resolve');
      continue;
    }

    files.set(`behavior_pack/blocks/${id.replace(':', '/')}.json`, { 'format_version': format, 'minecraft:block': {
      description: { identifier: id, states: { 'minecraft:cardinal_direction': ['north', 'south', 'east', 'west'] } },
      components: { 'minecraft:geometry': identifier, 'minecraft:material_instances': materials }, permutations: block['minecraft:block'].permutations,
    } });
    approximations.push({ kind: 'block', id, reasons: model.provenance.warnings! });
  }

  for (const [id, reasons] of notes) {
    approximations.push({ kind: id.startsWith('geometry.') ? 'model' : 'block', id, reasons: [...reasons] });
  }

  for (const [id, explicit] of Object.entries(bindings.items ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (native.items[id]?.textures) {
      continue;
    }

    const textures: Record<string, string> = {};

    try {
      for (const [slot, reference] of Object.entries(explicit)) {
        if (typeof reference === 'string' && reference.startsWith('item:')) {
          textures[slot] = reference.slice(5);
        } else {
          const variants = typeof reference === 'string' ? undefined : resources.get('textures/item_texture.json')?.texture_data?.[reference.alias]?.textures;
          const path = typeof reference === 'string' ? reference : paths(Array.isArray(variants) ? variants[reference.index] : undefined)[0];

          if (!path || !nativePaths.has(path)) {
            throw new Error('Item texture does not resolve to an upstream path');
          }

          let alias = itemAliasByPath.get(path);

          if (!alias) {
            alias = availableName('bedrock_core_asset_maps_' + namePart(id + (slot === 'default' ? '' : '_' + slot)), itemNames);
            itemAliases[alias] = { textures: path };
            itemAliasByPath.set(path, alias);
          }

          textures[slot] = alias;
        }
      }

      files.set(`behavior_pack/items/${id.replace(':', '/')}.json`, { 'format_version': format, 'minecraft:item': { description: { identifier: id }, components: { 'minecraft:icon': { textures } } } });
    } catch (error) { fail('item', id, asError(error).message); }
  }

  const renderKeys = new Set(['minecraft:geometry', 'minecraft:material_instances', 'minecraft:transformation', 'minecraft:item_visual', 'minecraft:light_emission', 'minecraft:light_dampening']);
  const authoredBlocks = new Set<string>(), authoredItems = new Set<string>(), resolvedBlocks = new Set<string>(), seenDefinitions = new Set<string>();

  for (const [file, original] of definitions) {
    if (!/^(?:behavior_pack\/(?:blocks|items)|resource_pack\/(?:models|entity|textures))\/.+\.json$/.test(file)) {
      throw new Error('Unsupported authored asset-map path: ' + file);
    }

    const document = structuredClone(original);
    const kind = document['minecraft:block'] ? 'minecraft:block' : document['minecraft:item'] ? 'minecraft:item' : undefined;

    if (kind) {
      let definition = document[kind]!;
      const id = definition.description?.identifier;

      if (typeof id !== 'string' || !id.includes(':')) {
        throw new Error('Authored asset requires a namespaced identifier: ' + file);
      }

      if (seenDefinitions.has(kind + '/' + id)) {
        throw new Error('Conflicting authored definition: ' + id);
      }

      seenDefinitions.add(kind + '/' + id);
      const automatic = [...files.values()].find(value => value[kind]?.description?.identifier === id)?.[kind];

      if (automatic) {
        definition = { ...automatic, ...definition, description: { ...automatic.description, ...definition.description }, components: { ...automatic.components, ...definition.components },
          ...(automatic.permutations || definition.permutations ? { permutations: [...automatic.permutations ?? [], ...definition.permutations ?? []] } : {}) };
      }

      if (kind === 'minecraft:block' && metadata) {
        const keys = nativeBlocks.get(id);

        if (!keys) {
          throw new Error('Not a vanilla Bedrock block: ' + id);
        }

        for (const [key, domain] of Object.entries(definition.description.states ?? {})) {
          if (!keys.has(key)) {
            throw new Error('State keys differ from vanilla Bedrock: ' + id);
          }

          if (Array.isArray(domain) && domain.some(value => !nativeStates.get(key)?.includes(value))) {
            throw new Error('State values differ from vanilla Bedrock: ' + id + '/' + key);
          }
        }
      }

      if (kind === 'minecraft:item' && definition.permutations?.length) {
        throw new Error('Item mappings use components and attachables, not block permutations');
      }

      const upstream = (kind === 'minecraft:block' ? native.blocks[id]?.['minecraft:block'] : native.items[id]?.['minecraft:item'])?.components ?? {};
      const keys = kind === 'minecraft:block' ? renderKeys : new Set(['minecraft:icon', 'minecraft:block_placer']);
      const missing = (value?: Components): Components => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => keys.has(key) && upstream[key] === undefined && !(kind === 'minecraft:item' && key === 'minecraft:icon' && native.items[id]?.textures)));
      const components = missing(definition.components), permutations = (definition.permutations ?? []).map(value => ({ ...value, components: missing(value.components) })).filter(value => Object.keys(value.components).length);

      if (!Object.keys(components).length && !permutations.length) {
        continue;
      }

      document[kind] = { ...definition, components, ...(permutations.length ? { permutations } : {}) };

      if (!permutations.length) {
        delete document[kind].permutations;
      }

      for (const [name, generated] of files) {
        if (generated[kind]?.description?.identifier === id) {
          files.delete(name);
        }
      }

      (kind === 'minecraft:block' ? authoredBlocks : authoredItems).add(id);

      if (kind === 'minecraft:block' && components['minecraft:geometry'] !== undefined) {
        resolvedBlocks.add(id);
      }
    } else if (file.startsWith('resource_pack/entity/')) {
      if (native.entities[document['minecraft:client_entity']?.description?.identifier ?? '']) {
        continue;
      }
    } else if (file.startsWith('resource_pack/models/')) {
      const geometries = document['minecraft:geometry'];

      if (!Array.isArray(geometries)) {
        throw new Error('Authored models require native geometry documents: ' + file);
      }

      document['minecraft:geometry'] = geometries.filter(value => !native.models[value.description?.identifier] || native.models[value.description?.identifier].provenance?.kind === 'supplemental');

      if (!document['minecraft:geometry'].length) {
        continue;
      }

      const ids = new Set(document['minecraft:geometry'].map(value => value.description?.identifier));

      for (const id of ids) {
        if (seenDefinitions.has('model/' + id)) {
          throw new Error('Conflicting authored model: ' + id);
        }

        seenDefinitions.add('model/' + id);
      }

      for (const [name, generated] of files) {
        if (generated['minecraft:geometry']) {
          const remaining = generated['minecraft:geometry'].filter(value => !ids.has(value.description?.identifier));

          if (remaining.length) {
            files.set(name, { ...generated, 'minecraft:geometry': remaining });
          } else { files.delete(name); }
        }
      }
    } else if (file.startsWith('resource_pack/textures/')) {
      if (!['resource_pack/textures/terrain_texture.json', 'resource_pack/textures/item_texture.json'].includes(file)) {
        throw new Error('Authored texture maps must use the native atlas filenames');
      }

      const upstream = resources.get(file.slice('resource_pack/'.length))?.texture_data ?? {};

      document.texture_data = Object.fromEntries(Object.entries(document.texture_data ?? {}).filter(([key]) => upstream[key] === undefined));

      if (!Object.keys(document.texture_data).length) {
        continue;
      }
    }

    files.set(file, document);
  }

  const unresolved = gaps.filter(gap => !((gap.kind === 'block' && resolvedBlocks.has(gap.id)) || (gap.kind === 'item' && authoredItems.has(gap.id))));
  const unresolvedIssues = issues.filter(issue => !((issue.kind === 'block' && resolvedBlocks.has(issue.id)) || (issue.kind === 'item' && authoredItems.has(issue.id))));
  const remainingApproximations = approximations.filter(gap => !resolvedBlocks.has(gap.id));
  const usedTerrain = new Set(), usedItems = new Set();

  for (const document of files.values()) {
    const block = document['minecraft:block'];

    for (const components of block ? [block.components, ...(block.permutations ?? []).map(value => value.components)] : []) {
      for (const material of Object.values(components?.['minecraft:material_instances'] ?? {})) {
        if (material?.texture) {
          usedTerrain.add(material.texture);
        }
      }
    }

    for (const alias of Object.values(document['minecraft:item']?.components?.['minecraft:icon']?.textures ?? {})) {
      usedItems.add(alias);
    }
  }

  for (const alias of Object.keys(aliases)) {
    if (!usedTerrain.has(alias)) {
      delete aliases[alias];
    }
  }

  for (const alias of Object.keys(itemAliases)) {
    if (!usedItems.has(alias)) {
      delete itemAliases[alias];
    }
  }

  if (Object.keys(aliases).length) {
    const authored = files.get('resource_pack/textures/terrain_texture.json');

    files.set('resource_pack/textures/terrain_texture.json', { resource_pack_name: 'asset_maps', texture_name: 'atlas.terrain', ...authored, texture_data: { ...aliases, ...authored?.texture_data } });
  }

  if (Object.keys(itemAliases).length) {
    const authored = files.get('resource_pack/textures/item_texture.json');

    files.set('resource_pack/textures/item_texture.json', { resource_pack_name: 'asset_maps', texture_name: 'atlas.items', ...authored, texture_data: { ...itemAliases, ...authored?.texture_data } });
  }

  const referenced = new Set<string>();

  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('geometry.bedrock_core.asset_maps.')) {
      referenced.add(value);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        collect(child);
      }
    }
  };

  for (const [name, value] of files) {
    if (name.startsWith('behavior_pack/')) {
      collect(value);
    }
  }

  for (const [name, value] of files) {
    if (name.startsWith('resource_pack/models/') && value['minecraft:geometry']![0].description.identifier.startsWith('geometry.bedrock_core.asset_maps.') && !referenced.has(value['minecraft:geometry']![0].description.identifier)) {
      files.delete(name);
    }
  }

  const remainingFallbacks = fallbacks.filter(value => !resolvedBlocks.has(value.id));

  return { files, coverage: { schemaVersion: 1, minecraft, sourceBlockStates: sourceStates, generatedBlockStates: mappedStates,
    fallbackBlockStates: remainingFallbacks.reduce((size, value) => size + value.affectedStates, 0), fallbacks: remainingFallbacks,
    upstreamBlocks: [...upstreamBlocks].sort(), authoredBlocks: [...authoredBlocks].sort(), resolvedAuthoredBlocks: [...resolvedBlocks].sort(), authoredItems: [...authoredItems].sort(), gaps: unresolved, issues: unresolvedIssues, approximations: remainingApproximations } };
}

export async function authoredDefinitions(directory: string): Promise<Resources> {
  const definitions: Resources = new Map();

  const visit = async (folder: string, prefix = ''): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });

    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = join(folder, entry.name), name = prefix + entry.name;

      if (entry.isDirectory()) {
        await visit(file, name + '/');
      } else if (entry.isFile() && name.endsWith('.json')) {
        definitions.set(name, parsePackJson(await readFile(file, 'utf8')));
      }
    }
  };

  await visit(directory);

  return definitions;
}

export async function writeDocuments({ documents: files, coverage, sourceLock, licenses, output = distribution, check = false, pretty }: WriteOptions): Promise<GenerationSummary> {
  const previous: { files: Record<string, string>; pretty?: boolean } = await readFile(join(output, 'index.json'), 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') {
      return { files: {} };
    }

    throw error;
  });

  pretty ??= previous.pretty ?? true;
  serializeJson(null, pretty);
  const index = { schemaVersion: 1, minecraft: sourceLock.minecraft, pretty, files: {} as Record<string, string> };

  for (const [name, document] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = serializeJson(document, pretty);

    index.files[name] = hash(bytes);

    if (check) {
      if (await readFile(join(output, name), 'utf8') !== bytes) {
        throw new Error('Stale asset map: ' + name);
      }
    } else {
      await mkdir(dirname(join(output, name)), { recursive: true });
      await writeFile(join(output, name), bytes);
    }
  }

  for (const name of Object.keys(previous.files)) {
    if (!files.has(name)) {
      if (check) {
        throw new Error('Obsolete asset map: ' + name);
      }

      const target = resolve(output, name);

      if (!target.startsWith(resolve(output) + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) {
        throw new Error('Invalid generated asset path');
      }

      await unlink(target);
    }
  }

  for (const [name, value] of [['source-lock.json', sourceLock], ['coverage.json', coverage], ['index.json', index]] as [string, unknown][]) {
    const text = serializeJson(value, pretty);

    if (check) {
      if (await readFile(join(output, name), 'utf8') !== text) {
        throw new Error('Stale asset map metadata: ' + name);
      }
    } else { await writeFile(join(output, name), text); }
  }

  for (const [name, bytes] of Object.entries(licenses)) {
    if (check) {
      if (!(await readFile(join(output, name))).equals(bytes)) {
        throw new Error('Stale asset map license: ' + name);
      }
    } else { await writeFile(join(output, name), bytes); }
  }

  return { documents: files.size, mappedStates: coverage.generatedBlockStates, gaps: coverage.gaps.length, issues: coverage.issues.length, pretty };
}
