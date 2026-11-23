import type { BlockStates, Vector3 } from '../compiler/types.ts';
import type { Bone, Components, Geometry, Material, NativeFace, EntityDocument, ModelSelection, NativeRendererAdapters } from './types.ts';
import type { RendererOptions } from './renderers.ts';
import { asError } from '../json.ts';
import { geometryFaces } from './geometry.ts';

type NativeSource = { identifier: string; geometry: Geometry; description: EntityDocument['minecraft:client_entity']['description'] };
type NativeMesh = { geometry: Geometry; faces: NativeFace[] };

const heads: Record<string, string> = { player_head: 'steve', skeleton_skull: 'skeleton', wither_skeleton_skull: 'wither', zombie_head: 'zombie', creeper_head: 'creeper', dragon_head: 'dragon', piglin_head: 'piglin' };
const add = (a: Vector3, b: Vector3): Vector3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (v: Vector3, n: number): Vector3 => ({ x: v.x * n, y: v.y * n, z: v.z * n });

const yaw = (v: Vector3, degrees: number): Vector3 => {
  const r = degrees * Math.PI / 180;

  return { x: v.x * Math.cos(r) + v.z * Math.sin(r), y: v.y, z: v.z * Math.cos(r) - v.x * Math.sin(r) };
};

/** Clip an axis-aligned native quad without changing its texture-to-position correspondence. */
export function clipNativeFace(face: NativeFace, minimum: number, maximum: number): NativeFace | undefined {
  const starts = [0, 0], ends = [1, 1];

  for (const [index, edge] of [face.u, face.v].entries()) {
    if (Math.abs(edge.y) < 1e-8) {
      continue;
    }

    const bounds = [(minimum - face.origin.y) / edge.y, (maximum - face.origin.y) / edge.y].sort((a, b) => a - b);

    starts[index] = Math.max(0, bounds[0]);
    ends[index] = Math.min(1, bounds[1]);
  }

  if ((Math.abs(face.u.y) < 1e-8 && Math.abs(face.v.y) < 1e-8 && (face.origin.y < minimum || face.origin.y > maximum))
    || ends.some((end, i) => end - starts[i] < 1e-8)) { return undefined; }

  return { ...face, origin: add(face.origin, add(scale(face.u, starts[0]), scale(face.v, starts[1]))), u: scale(face.u, ends[0] - starts[0]), v: scale(face.v, ends[1] - starts[1]),
    uv: [face.uv[0] + face.uv[2] * starts[0], face.uv[1] + face.uv[3] * starts[1], face.uv[2] * (ends[0] - starts[0]), face.uv[3] * (ends[1] - starts[1])] };
}

/** Adapt vanilla entity meshes to native block states; source geometry and texture aliases stay Bedrock-owned. */
export function createNativeRendererAdapters({ native, textures, emit, faceCube, textureAlias, note }: Pick<RendererOptions, 'native' | 'textures' | 'faceCube' | 'textureAlias' | 'note'> & { emit(parts: Bone[], materials: Record<string, Material>): Components }): NativeRendererAdapters {
  const meshes = new Map<string, NativeMesh>(), selections = new Map<string, Components | Error>();
  const entity = (id: string): NativeSource['description'] | undefined => native.entities['minecraft:' + id]?.['minecraft:client_entity'].description;

  const source = (id: string, alias = 'default'): NativeSource | undefined => {
    const description = entity(id), identifier = description?.geometry?.[alias];

    return identifier && native.models[identifier] ? { description, identifier, geometry: native.models[identifier].geometry } : undefined;
  };

  const kind = (id: string): 'bed' | 'shulker' | 'head' | 'statue' | undefined => {
    const name = id.replace(/^minecraft:/, '');

    if (id === 'minecraft:bed' && source('bed')) {
      return 'bed';
    }

    if (id.startsWith('minecraft:') && name.endsWith('_shulker_box') && source('shulker')) {
      return 'shulker';
    }

    if (id.startsWith('minecraft:') && heads[name] && source('skull', heads[name])) {
      return 'head';
    }

    if (id.startsWith('minecraft:') && name.endsWith('copper_golem_statue') && source('copper_golem', 'standing')) {
      return 'statue';
    }

    return undefined;
  };

  const material = (path: string | undefined): Record<string, Material> => {
    const method = textures?.images[path ?? '']?.method;

    if (!method) {
      throw new Error('Native entity texture image is absent: ' + path);
    }

    return { '*': { texture: textureAlias(path!), render_method: method === 'blend' ? 'blend' : 'alpha_test_single_sided' } };
  };

  const mesh = (input: NativeSource, headOnly = false): NativeMesh => {
    const key = input.identifier + '/' + headOnly;

    if (!meshes.has(key)) {
      const geometry = headOnly ? structuredClone(input.geometry) : input.geometry;

      if (headOnly) {
        const selected = new Set(['head']);

        for (let size = -1; size !== selected.size;) {
          size = selected.size;

          for (const bone of geometry.bones) {
            if (selected.has(bone.parent ?? '')) {
              selected.add(bone.name);
            }
          }
        }

        geometry.bones = geometry.bones.filter(bone => selected.has(bone.name));

        for (const bone of geometry.bones) {
          if (!selected.has(bone.parent ?? '')) {
            delete bone.parent;
          }
        }
      }

      meshes.set(key, { geometry, faces: geometryFaces(geometry) });
    }

    return meshes.get(key)!;
  };

  const bake = (input: NativeMesh, faces: NativeFace[], point: (v: Vector3) => Vector3, direction: (v: Vector3) => Vector3, materials: Record<string, Material>): Components => {
    const bones = new Map<string, Bone>();

    for (const face of faces) {
      const origin = point(face.origin), u = direction(face.u), v = direction(face.v);
      const packed = [(origin.x + u.x + 8) / 16, (origin.y + u.y) / 16, (8 - origin.z - u.z) / 16,
        -u.x / 16, -u.y / 16, u.z / 16, v.x / 16, v.y / 16, -v.z / 16,
        face.uv[0] + face.uv[2], face.uv[1] + face.uv[3], -face.uv[2], -face.uv[3]];

      if (!bones.has(face.bone)) {
        const source = input.geometry.bones.find(bone => bone.name === face.bone)!, pivot = point({ x: source.pivot?.[0] ?? 0, y: source.pivot?.[1] ?? 0, z: source.pivot?.[2] ?? 0 });

        bones.set(face.bone, { name: face.bone, pivot: [pivot.x, pivot.y, pivot.z], cubes: [] });
      }

      bones.get(face.bone)!.cubes!.push(faceCube(packed, '*'));
    }

    for (const bone of bones.values()) {
      const parent = input.geometry.bones.find(source => source.name === bone.name)?.parent;

      if (parent && bones.has(parent)) {
        bone.parent = parent;
      }
    }

    return emit([...bones.values()], materials);
  };

  return {
    supports: (id: string) => kind(id) !== undefined,
    block(id: string, states: BlockStates): ModelSelection {
      const type = kind(id);

      if (!type) {
        return undefined;
      }

      const key = JSON.stringify([id, states]);

      if (selections.has(key)) {
        return selections.get(key);
      }

      let result: Components | Error;

      try {
        if (type === 'bed') {
          const input = source('bed')!, rest = mesh(input), head = states.head_piece_bit;
          const rotation = [180, 270, 0, 90][Number(states.direction)];

          if (rotation === undefined) {
            throw new Error('Unknown native bed direction');
          }

          const faces = rest.faces.map(face => clipNativeFace(face, head ? 16 : 0, head ? 32 : 16)).filter((face): face is NativeFace => face !== undefined);
          const direction = (v: Vector3): Vector3 => yaw({ x: v.x, y: -v.z, z: v.y }, rotation);
          const point = (v: Vector3): Vector3 => yaw({ x: v.x - 8, y: 9 - v.z, z: v.y - (head ? 24 : 8) }, rotation);

          result = bake(rest, faces, point, direction, material(input.description.textures?.default));
          note(id, 'Native bed geometry uses the default entity texture; bed colour requires block-entity data.');
        } else if (type === 'shulker') {
          const input = source('shulker')!, colour = id.slice('minecraft:'.length, -'_shulker_box'.length).replace('light_gray', 'silver');

          result = { 'minecraft:geometry': { identifier: input.identifier, bone_visibility: { head: false } }, 'minecraft:material_instances': material(input.description.textures?.[colour]) };
          note(id, 'The native shulker base and lid use their closed rest pose; opening and facing require block-entity data.');
        } else if (type === 'head') {
          const alias = heads[id.slice('minecraft:'.length)], input = source('skull', alias)!, rest = mesh(input, alias === 'piglin');
          const base = Math.min(...rest.geometry.bones.flatMap(bone => (bone.cubes ?? []).map(cube => cube.origin[1])));
          const facing = Number(states.facing_direction), rotation = [0, 0, 180, 0, 90, 270][facing], wall = facing >= 2;

          if (rotation === undefined) {
            throw new Error('Unknown native skull facing');
          }

          const size = alias === 'dragon' ? 0.75 : 1;
          const direction = (v: Vector3): Vector3 => yaw(scale(v, size), rotation);
          const point = (v: Vector3): Vector3 => yaw(add(scale({ x: v.x, y: v.y - base, z: v.z }, size), { x: 0, y: wall ? 4 : 0, z: wall ? 4 : 0 }), rotation);

          result = bake(rest, rest.faces, point, direction, material(input.description.textures?.[alias]));
          note(id, 'Native skull geometry supplies the static head; floor rotation, custom skins and animation require block-entity data.');
        } else {
          const input = source('copper_golem', 'standing')!, role = id.replace(/^minecraft:(?:waxed_)?/, '').match(/^(exposed|weathered|oxidized)_/)?.[1] ?? 'default';

          result = { 'minecraft:geometry': input.identifier, 'minecraft:material_instances': material(input.description.textures?.[role]),
            'minecraft:transformation': { rotation: [0, ({ south: 0, east: 90, north: 180, west: -90 } as Record<string, number>)[String(states['minecraft:cardinal_direction'])], 0] } };
          note(id, 'The native copper golem supplies the standing statue; other poses require block-entity data.');
        }
      } catch (error) { result = asError(error); }

      selections.set(key, result);

      return result;
    },
  };
}
