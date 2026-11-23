import type { Bone, Geometry, NativeFace } from './types.ts';
import { boxFaces, boxUvRects, transformFace } from '../compiler/faces.ts';
import { Quat, V3, type Quaternion, type Vector3 } from '../compiler/math.ts';

interface Rotation { orientation: Quaternion; pivot: Vector3 }

const vector = ([x, y, z]: readonly number[]): Vector3 => ({ x, y, z });
// Signed zero changes which equivalent half-turn atan2 returns for a face axis.
const normalizeZeros = ({ x, y, z }: Vector3): Vector3 => ({ x: x + 0, y: y + 0, z: z + 0 });
const rotationAt = (rotation: readonly number[], pivot = [0, 0, 0]): Rotation => ({
  orientation: Quat.fromEuler(vector(rotation)),
  pivot: vector(pivot),
});

/** Resolve textured cube faces in the Bedrock geometry's rest pose. */
export function geometryFaces(geometry: Geometry): NativeFace[] {
  const identifier = geometry.description?.identifier ?? 'Native geometry';
  const textureWidth = geometry.description?.texture_width ?? geometry.texturewidth ?? 16;
  const textureHeight = geometry.description?.texture_height ?? geometry.textureheight ?? 16;

  if (![textureWidth, textureHeight].every(size => Number.isFinite(size) && size > 0)) {
    throw new Error(identifier + ': texture dimensions must be positive');
  }

  const bones = new Map<string, Bone>();

  for (const bone of geometry.bones ?? []) {
    if (!bone.name || bones.has(bone.name)) {
      throw new Error(identifier + ': bone names must be nonempty and unique');
    }

    bones.set(bone.name, bone);
  }

  const rotations = new Map<string, Rotation[]>();

  const boneRotations = (bone: Bone, ancestors = new Set<string>()): Rotation[] => {
    const cached = rotations.get(bone.name);

    if (cached) {
      return cached;
    }

    if (ancestors.has(bone.name)) {
      throw new Error(identifier + ': cyclic bone hierarchy');
    }

    const pose = bone.rotation ? [rotationAt(bone.rotation, bone.pivot)] : [];

    if (bone.parent) {
      const parent = bones.get(bone.parent);

      if (!parent) {
        throw new Error(identifier + ': missing bone parent ' + bone.parent);
      }

      pose.push(...boneRotations(parent, new Set([...ancestors, bone.name])));
    }

    rotations.set(bone.name, pose);

    return pose;
  };

  const result: NativeFace[] = [];

  for (const bone of bones.values()) {
    const pose = boneRotations(bone);

    if (bone.poly_mesh || bone.texture_meshes?.length) {
      throw new Error(identifier + '/' + bone.name + ': poly_mesh and texture_meshes require a compatible backend');
    }

    for (const cube of bone.cubes ?? []) {
      const { origin, size, inflate = 0 } = cube;

      if (!origin || !size || origin.length !== 3 || size.length !== 3
        || ![...origin, ...size, inflate].every(Number.isFinite) || size.some(value => value < 0)) {
        throw new Error(identifier + ': cube requires a finite origin and nonnegative size');
      }

      const expansion = { x: inflate, y: inflate, z: inflate };
      const min = V3.subtract(vector(origin), expansion), max = V3.add(V3.add(vector(origin), vector(size)), expansion);
      const cubePose = cube.rotation ? [rotationAt(cube.rotation, cube.pivot ?? bone.pivot), ...pose] : pose;
      const faceUvs = cube.uv && !Array.isArray(cube.uv) ? cube.uv : undefined;
      const boxUvs = faceUvs ? undefined : boxUvRects(size, Array.isArray(cube.uv) ? cube.uv : [0, 0], cube.mirror ?? bone.mirror);

      for (const face of boxFaces({ min, max }, { texture: 0 })) {
        const side = face.side === 'east' ? 'west' : face.side === 'west' ? 'east' : face.side!;
        let rect: [number, number, number, number];

        if (boxUvs) {
          rect = boxUvs[side];
        } else {
          const entry = faceUvs?.[side];

          if (!entry) {
            continue;
          }

          if (!entry.uv) {
            throw new Error(identifier + ': face UV origin is unavailable');
          }

          const [width, height] = entry.uv_size ?? [V3.length(face.u), V3.length(face.v)];

          rect = [entry.uv[0], entry.uv[1], width, height];
        }

        // Native UVs start at the upper left. The top and bottom use the box axes directly.
        const cap = side === 'up' || side === 'down';
        const oriented = cap
          ? face
          : { ...face, origin: V3.add(face.origin, V3.add(face.u, face.v)), u: V3.scale(face.u, -1), v: V3.scale(face.v, -1) };
        const transformed = cubePose.reduce((surface, rotation) => transformFace(surface, rotation.orientation, rotation.pivot), oriented);
        const uv = [rect[0] / textureWidth, rect[1] / textureHeight, rect[2] / textureWidth, rect[3] / textureHeight];

        if (![...Object.values(transformed.origin), ...Object.values(transformed.u), ...Object.values(transformed.v), ...uv].every(Number.isFinite)) {
          throw new Error(identifier + ': non-finite geometry');
        }

        if (V3.length(V3.cross(transformed.u, transformed.v)) > 1e-9) {
          result.push({
            origin: normalizeZeros(transformed.origin),
            u: normalizeZeros(transformed.u),
            v: normalizeZeros(transformed.v),
            uv,
            bone: bone.name,
          });
        }
      }
    }
  }

  return result;
}
