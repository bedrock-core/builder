import { Quat, V3, type Quaternion, type Vector3 } from './math.ts';
import type { RenderBox, RenderFace, RenderMaterial } from './types.ts';

export type CubeSide = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export interface CubeTexture {
  texture: number;
  uv?: readonly [number, number, number, number];
  material?: RenderMaterial;
  tint?: readonly [number, number, number, number];
  repeat?: boolean;
}
export type CubeTextures = CubeTexture | Record<CubeSide, CubeTexture>;
export const cellKey = (p: Vector3): string => `${p.x},${p.y},${p.z}`;
export const cross = (a: Vector3, b: Vector3): Vector3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const length = (v: Vector3): number => Math.hypot(v.x, v.y, v.z);
export const scale = (v: Vector3, s: number): Vector3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });

type UvRect = [number, number, number, number];

/** Resolve the face rectangles on a box UV sheet in texture pixels. */
export function boxUvRects(size: readonly number[], uv: readonly number[], mirror = false): Record<CubeSide, UvRect> {
  const [dx, dy, dz] = size, [u, v] = uv;
  const rectangles: Record<CubeSide, UvRect> = {
    north: [u + dz, v + dz, dx, dy],
    south: [u + 2 * dz + dx, v + dz, dx, dy],
    east: [u, v + dz, dz, dy],
    west: [u + dz + dx, v + dz, dz, dy],
    up: [u + dz, v, dx, dz],
    down: [u + dz + dx, v + dz, dx, -dz],
  };

  if (mirror) {
    [rectangles.east, rectangles.west] = [rectangles.west, rectangles.east];

    for (const side of Object.keys(rectangles) as CubeSide[]) {
      const [x, y, width, height] = rectangles[side];

      rectangles[side] = [x + width, y, -width, height];
    }
  }

  return rectangles;
}

/** Shared box-to-visual conversion for authored block and individual display assets. */
export function boxFaces(box: RenderBox, textures: CubeTextures): RenderFace[] {
  const { min: a, max: b } = box;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;

  const f = (side: CubeSide, origin: Vector3, u: Vector3, v: Vector3): RenderFace => {
    const texture = 'texture' in textures ? textures : textures[side];

    return { ...texture, side, uv: texture.uv ?? [0, 0, 1, 1], origin, u, v };
  };

  return [
    f('north', { x: b.x, y: a.y, z: a.z }, { x: -dx, y: 0, z: 0 }, { x: 0, y: dy, z: 0 }),
    f('south', { x: a.x, y: a.y, z: b.z }, { x: dx, y: 0, z: 0 }, { x: 0, y: dy, z: 0 }),
    f('east', { x: b.x, y: a.y, z: b.z }, { x: 0, y: 0, z: -dz }, { x: 0, y: dy, z: 0 }),
    f('west', { x: a.x, y: a.y, z: a.z }, { x: 0, y: 0, z: dz }, { x: 0, y: dy, z: 0 }),
    f('up', { x: a.x, y: b.y, z: b.z }, { x: dx, y: 0, z: 0 }, { x: 0, y: 0, z: -dz }),
    f('down', { x: a.x, y: a.y, z: a.z }, { x: dx, y: 0, z: 0 }, { x: 0, y: 0, z: dz }),
  ].filter(face => length(face.u) > 0 && length(face.v) > 0);
}

export function transformFace(face: RenderFace, orientation: Quaternion, pivot: Vector3): RenderFace {
  return { ...face, origin: V3.add(pivot, Quat.rotateVector(orientation, V3.subtract(face.origin, pivot))),
    u: Quat.rotateVector(orientation, face.u), v: Quat.rotateVector(orientation, face.v) };
}

/** A proper rotation basis for the client quad, whose model Z axis is mirrored. */
export function faceEuler(face: RenderFace): Vector3 {
  const u = scale(face.u, 1 / length(face.u)), v = scale(face.v, 1 / length(face.v));
  const x = { x: u.x, y: u.y, z: -u.z }, y = { x: v.x, y: v.y, z: -v.z };
  const z = cross(x, y);
  const pitch = Math.atan2(y.z, z.z), yaw = Math.atan2(-x.z, Math.hypot(x.x, x.y)), roll = Math.atan2(x.y, x.x);

  return { x: pitch * 180 / Math.PI, y: yaw * 180 / Math.PI, z: roll * 180 / Math.PI };
}
