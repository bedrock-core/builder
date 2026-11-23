import type { ExtractedEntityModel } from '../compiler/entity.ts';
import type { CompiledModelSource, ModelApplication, PackedFace, BlockStates } from '../compiler/types.ts';
import type { InverseRow } from '../compiler/inverse.ts';
import type { TextureBindings } from '../compiler/textures.ts';
import type { RendererInputs, RendererPart } from '../sources/types.ts';
import type { Bone, Catalog, Components, Cube, Material, Resources, ModelSelection, RendererAdapters } from './types.ts';
import { asError } from '../json.ts';
import { createHash } from 'node:crypto';
import { availableName, namePart } from './names.ts';
import { createNativeRendererAdapters } from './native-renderers.ts';
import { entityModelFaces } from '../compiler/entity.ts';
import { compileGeometry } from '../compiler/geometry.ts';

export interface RendererOptions {
  inputs?: RendererInputs; compiled: CompiledModelSource; textures?: TextureBindings; native: Catalog; files: Resources;
  faceCube(face: PackedFace, slot: string): Cube;
  rotateFace(face: PackedFace, application: ModelApplication): PackedFace;
  textureAlias(path: string): string;
  note(id: string, message: string): void;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const clean = (source: string): string => source.replace(/^minecraft:/, '').replace(/^textures\//, '').replace(/\.(?:png|tga)$/, '');
const matches = (when: Record<string, string> | undefined, properties: Record<string, string>): boolean => !when || Object.entries(when).every(([key, value]) => String(value).split('|').includes(properties[key]));

/** Static block-entity rest poses and entity-only block models, projected onto native state selections. */
export function createRendererAdapters({ inputs, compiled, textures, native, files, faceCube, rotateFace, textureAlias, note }: RendererOptions): RendererAdapters {
  const cache = new Map<string, Components | Error>();

  const emit = (parts: Bone[], materials: Record<string, Material>): Components => {
    const key = hash(parts), identifier = 'geometry.bedrock_core.asset_maps.' + key;
    const file = 'resource_pack/models/blocks/' + key + '.geo.json';

    if (!files.has(file)) {
      files.set(file, { 'format_version': '1.16.0', 'minecraft:geometry': [{ description: { identifier, texture_width: 16, texture_height: 16 }, bones: parts }] });
    }

    return { 'minecraft:geometry': identifier, 'minecraft:material_instances': materials };
  };

  const bedrock = createNativeRendererAdapters({ native, textures, emit, faceCube, textureAlias, note });

  if (!inputs) {
    return { supports: bedrock.supports, supportsNative: bedrock.supports, nativeBlock: bedrock.block, block: (): ModelSelection => undefined, entities: (): void => {} };
  }

  const empty = (): Components => emit([{ name: 'root', cubes: [] }], { '*': { texture: 'stone', render_method: 'opaque' } });

  const sheet = (source: string, dimensions: readonly [number, number]): string => {
    const path = inputs.textures[clean(source) + '|' + dimensions.join(',')];

    if (typeof path !== 'string') {
      throw new Error(`Entity texture cannot resolve: ${source}: ${path?.error ?? 'missing binding'}`);
    }

    return path;
  };

  const entityParts = (descriptors: RendererPart[], rotation: number, translation?: readonly [number, number, number], entity = false): { parts: Bone[]; materials: Record<string, Material> } => {
    const parts: Bone[] = [], materials: Record<string, Material> = {}, slots = new Set<string>();

    for (const descriptor of descriptors) {
      const model: ExtractedEntityModel = inputs.models[descriptor.model];
      const layerName = descriptor.layer ?? 'main';
      const layer: ExtractedEntityModel['layers'][string] | undefined = model?.layers[layerName], nativeTexture = descriptor.nativeTexture;

      if (!layer) {
        throw new Error('Extracted entity model layer is absent: ' + descriptor.model + '/' + layerName);
      }

      const path = nativeTexture ?? sheet(descriptor.textureLocation ?? layer.textureLocation ?? '', layer.texture);
      const slot = availableName(namePart(descriptor.model.split('/').at(-1) + (layerName === 'main' ? '' : '_' + layerName)), slots);
      const method = textures?.images[path]?.method;

      if (!method) {
        throw new Error('Native entity texture image is absent: ' + path);
      }

      materials[slot] = { texture: textureAlias(path), render_method: layer.render === 'solid' ? 'opaque' : layer.render?.startsWith('translucent') || method === 'blend' ? 'blend' : 'alpha_test_single_sided' };

      for (const bone of entityModelFaces(model, layerName, { rotation, translation, entity })) {
        const cubes = bone.faces.map(face => faceCube(face, entity ? 'default' : slot));

        parts.push({ name: bone.name, ...(bone.parent ? { parent: bone.parent } : {}), pivot: bone.pivot, ...(cubes.length ? { cubes } : {}) });
      }
    }

    return { parts, materials };
  };

  const special = (id: string, row?: Partial<InverseRow>): ModelSelection => {
    const java = row?.java, properties = row?.properties;

    if (!java || !properties) {
      return undefined;
    }

    let definition = inputs.blocks[java], overrideTexture: string | undefined;

    // New woods can share the extracted family geometry while retaining their current Bedrock texture.
    if (!definition && /_(?:wall_)?(?:hanging_)?sign$/.test(java)) {
      const match = java.match(/^minecraft:(.+?)_(wall_)?(hanging_)?sign$/);

      if (match) {
        definition = inputs.blocks['minecraft:oak_' + (match[2] ?? '') + (match[3] ?? '') + 'sign'];
        const path = `textures/entity/${match[1]}_${match[3] ?? ''}sign`;

        if (textures?.images[path]) {
          overrideTexture = path;
        }
      }
    }

    if (!definition) {
      return undefined;
    }

    const selected = definition.parts.filter(part => matches(part.when, properties));

    if (!selected.length) {
      return undefined;
    }

    const descriptors = selected.map(part => ({ ...part, ...(overrideTexture ? { nativeTexture: overrideTexture } : {}) }));
    const rotation = definition.rotation ? definition.rotation.degrees?.[properties[definition.rotation.property]] ?? Number(properties[definition.rotation.property]) * Number(definition.rotation.step) : 0;

    if (!Number.isFinite(rotation)) {
      return new Error('Block-entity facing has no extracted rotation');
    }

    const key = JSON.stringify([descriptors, rotation, definition.translation]);

    if (!cache.has(key)) {
      try {
        const result = entityParts(descriptors, rotation, definition.translation);

        cache.set(key, emit(result.parts, result.materials));
      } catch (error) { cache.set(key, asError(error)); }
    }

    const result = cache.get(key);

    if (!(result instanceof Error)) {
      note(id, `Static block-entity rest pose from Java ${inputs.source.java}; animation and block-entity appearance data require a runtime adapter.`);
    }

    return result;
  };

  const frame = (id: string, states: BlockStates): ModelSelection => {
    const key = JSON.stringify([id, states.facing_direction, states.item_frame_map_bit]);

    if (cache.has(key)) {
      return cache.get(key);
    }

    try {
      const name = (id === 'minecraft:glow_frame' ? 'glow_item_frame' : 'item_frame') + (states.item_frame_map_bit ? '_map' : '');
      const model = inputs.frameModels[name], symbols: string[] = [];
      const geometry = compileGeometry(model, (symbol) => {
        let source = symbol;
        const seen = new Set();

        while (source.startsWith('#')) {
          if (seen.has(source)) {
            throw new Error('Cyclic frame texture');
          }

          seen.add(source);
          const next = model.textures?.[source.slice(1)];

          if (typeof next !== 'string') {
            throw new Error('Frame texture does not resolve to a string');
          }

          source = next;
        }

        if (!symbols.includes(source)) {
          symbols.push(source);
        }

        return symbols.indexOf(source);
      });
      const direction = Number(states.facing_direction);
      const application: ModelApplication = [0, direction === 0 ? 90 : direction === 1 ? 270 : 0, ({ 2: 0, 3: 180, 4: 270, 5: 90 } as Record<number, number>)[direction] ?? 0, 0, 1];
      const slots = symbols.map(source => source.includes('item_frame') ? 'back' : 'wood');
      const materials = Object.fromEntries(symbols.map((source, i) => [slots[i], { texture: textureAlias(sheet(source, [16, 16])), render_method: 'alpha_test_single_sided' }]));
      const cubes = geometry.faces.map(face => faceCube(rotateFace(face, application), slots[face[13]]));
      const result = emit([{ name: 'frame', cubes }], materials);

      cache.set(key, result);
      note(id, 'Frame geometry is available; displayed items, maps and photographs require block-entity content.');

      if (id === 'minecraft:glow_frame') {
        note(id, 'Full-bright frame presentation requires a display material adapter.');
      }

      return result;
    } catch (error) {
      const failure = asError(error);

      cache.set(key, failure);

      return failure;
    }
  };

  const chain = (id: string, row: Partial<InverseRow>): Components | undefined => {
    if (row.program === undefined) {
      return undefined;
    }

    const groups = compiled.programs[row.program], binding = native.blocks[id]?.textures;

    if (groups?.length !== 1 || typeof binding !== 'object') {
      return undefined;
    }

    const applications = compiled.groups[groups[0]];

    if (applications.length !== 1) {
      return undefined;
    }

    const application = applications[0], model = compiled.models[application[0]], faces = compiled.geometries[model.geometry].faces;

    if (faces.length !== 4 || faces.some(face => Math.abs(Math.abs(face[11]) - 3 / 16) > 1e-6 || Math.abs(face[12]) !== 1)) {
      return undefined;
    }

    const materials = Object.fromEntries((['up', 'side'] as const).map(side => [side, { texture: binding[side], render_method: 'alpha_test_single_sided' }]));

    if (Object.values(materials).some(value => !native.textures[value.texture ?? ''])) {
      return undefined;
    }

    const cubes = faces.map((face) => {
      const minimum = Math.min(face[9], face[9] + face[11]), part = minimum < 3 / 16 - 1e-6 ? 'up' : 'side';
      const remapped = [...face];

      remapped[9] -= part === 'side' ? 3 / 16 : 0;

      if (Math.min(remapped[9], remapped[9] + remapped[11]) < -1e-6 || Math.max(remapped[9], remapped[9] + remapped[11]) > 3 / 16 + 1e-6) {
        throw new Error('Unsupported native chain UV layout');
      }

      return faceCube(rotateFace(remapped, application), part);
    });

    return emit([{ name: 'chain', cubes }], materials);
  };

  return {
    supports: (id: string) => bedrock.supports(id) || id === 'minecraft:frame' || id === 'minecraft:glow_frame',
    supportsNative: bedrock.supports,
    nativeBlock: bedrock.block,
    block(id: string, states: BlockStates, row: Partial<InverseRow>): ModelSelection {
      if (/^minecraft:light_block_\d+$/.test(id) || (row?.java === 'minecraft:pitcher_crop' && row.properties?.half === 'upper' && Number(row.properties.age) < 3)) {
        return empty();
      }

      if (id === 'minecraft:frame' || id === 'minecraft:glow_frame') {
        return frame(id, states);
      }

      if (id.endsWith('_chain')) {
        return chain(id, row);
      }

      if (id === 'minecraft:unknown' && native.textures.missing_tile) {
        note(id, 'The internal unknown block uses the native missing-texture cube placeholder.');

        return { 'minecraft:geometry': 'minecraft:geometry.full_block', 'minecraft:material_instances': { '*': { texture: 'missing_tile', render_method: 'opaque' } } };
      }

      return special(id, row);
    },
    entities(): void {
      for (const [id, model] of [['geometry.boat', 'minecraft:boat/oak'], ['geometry.chest_boat', 'minecraft:chest_boat/oak']]) {
        if (native.models[id]) {
          continue;
        }

        try {
          const result = entityParts([{ model }], 0, undefined, true);

          files.set('resource_pack/models/entity/' + id.slice('geometry.'.length) + '.geo.json', { 'format_version': '1.16.0', 'minecraft:geometry': [{ description: { identifier: id, texture_width: 16, texture_height: 16 }, bones: result.parts }] });
          note(id, `Static classic-boat rest pose from Java ${inputs.source.java}; rowing and raft variants require runtime selection.`);
        } catch (error) { note(id, asError(error).message); }
      }
    },
  };
}
