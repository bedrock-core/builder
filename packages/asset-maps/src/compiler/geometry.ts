import { Quat, V3, type Vector3 } from './math.ts';
import { boxFaces, cross, length, transformFace } from './faces.ts';
import type { RenderBox, RenderFace } from './types.ts';
import { SIDES, type Bounds, type JavaModel, type ModelGeometry, type PackedFace, type Side, type Triple } from './types.ts';

const vector = (v: Triple): Vector3 => ({ x: v[0], y: v[1], z: v[2] });
const round = (v: number): number => Math.abs(v) < 1e-8 ? 0 : Math.round(v * 1e8) / 1e8;
const pivot = { x: 0.5, y: 0.5, z: 0.5 };

export const boxOf = (b: Bounds): RenderBox => ({ min: { x: b[0], y: b[1], z: b[2] }, max: { x: b[3], y: b[4], z: b[5] } });
export const boundsOf = (b: RenderBox): Bounds => [round(b.min.x), round(b.min.y), round(b.min.z), round(b.max.x), round(b.max.y), round(b.max.z)];
const normalOf = (side: Side): Vector3 => ({ north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, down: { x: 0, y: -1, z: 0 } })[side];
const sideOf = (n: Vector3): Side | undefined => SIDES.find(side => V3.dot(normalOf(side), n) > 0.99999 * length(n));

export function blockRotation(v: Vector3, x: number, y: number): Vector3 {
  const qx = Quat.fromEuler({ x: -x, y: 0, z: 0 }), qy = Quat.fromEuler({ x: 0, y: -y, z: 0 });

  return Quat.rotateVector(qy, Quat.rotateVector(qx, v));
}

export function rotateBox(box: RenderBox, x: number, y: number): RenderBox {
  const points = [box.min.x, box.max.x].flatMap(a => [box.min.y, box.max.y].flatMap(b => [box.min.z, box.max.z].map(c => V3.add(pivot, blockRotation(V3.subtract({ x: a, y: b, z: c }, pivot), x, y)))));
  const bound = (fn: typeof Math.min): Vector3 => ({ x: round(fn(...points.map(p => p.x))), y: round(fn(...points.map(p => p.y))), z: round(fn(...points.map(p => p.z))) });

  return { min: bound(Math.min), max: bound(Math.max) };
}

/** Reparameterize quarter-turn UVs without changing the geometric winding. */
function frame(face: RenderFace, a: number[], b: number[], c: number[]): RenderFace {
  if (Math.abs(b[1] - a[1]) < 1e-7 && Math.abs(c[0] - a[0]) < 1e-7) {
    return { ...face, uv: [a[0], a[1], b[0] - a[0], c[1] - a[1]] };
  }

  if (Math.abs(b[0] - a[0]) > 1e-7 || Math.abs(c[1] - a[1]) > 1e-7) {
    throw new Error('Non-orthogonal Java UV mapping');
  }

  return { ...face, origin: V3.add(face.origin, face.v), u: V3.scale(face.v, -1), v: face.u, uv: [c[0], c[1], a[0] - c[0], b[1] - a[1]] };
}

const defaultUv = (side: Side, a: Triple, b: Triple): number[] => ({
  north: [16 - b[0], 16 - b[1], 16 - a[0], 16 - a[1]], south: [a[0], 16 - b[1], b[0], 16 - a[1]],
  east: [16 - b[2], 16 - b[1], 16 - a[2], 16 - a[1]], west: [a[2], 16 - b[1], b[2], 16 - a[1]],
  up: [a[0], a[2], b[0], b[2]], down: [a[0], 16 - b[2], b[0], 16 - a[2]],
})[side];

/** Bake element transforms and face UV rotations; blockstate rotations remain shared applications. */
export function compileGeometry(model: JavaModel, texture: (value: string) => number): ModelGeometry {
  const faces: PackedFace[] = [], boxes: ModelGeometry['boxes'] = [];

  for (const element of model.elements ?? []) {
    const box = { min: V3.scale(vector(element.from), 1 / 16), max: V3.scale(vector(element.to), 1 / 16) };
    let sides = 0;
    const slots = new Set<number>();
    const rotation = element.rotation;

    const apply = (f: RenderFace): RenderFace => {
      if (!rotation) {
        return f;
      }

      const euler = { x: 0, y: 0, z: 0, [rotation.axis]: rotation.angle };
      const at = V3.scale(vector(rotation.origin), 1 / 16);
      let result = transformFace(f, Quat.fromEuler(euler), at);

      if (rotation.rescale) {
        const factor = 1 / Math.abs(Math.cos(rotation.angle * Math.PI / 180));

        if (!Number.isFinite(factor) || factor > 2) {
          throw new Error('Unsupported element rescale');
        }

        const scale = (v: Vector3): Vector3 => ({ x: v.x * (rotation.axis === 'x' ? 1 : factor), y: v.y * (rotation.axis === 'y' ? 1 : factor), z: v.z * (rotation.axis === 'z' ? 1 : factor) });

        result = { ...result, origin: V3.add(at, scale(V3.subtract(result.origin, at))), u: scale(result.u), v: scale(result.v) };
      }

      return result;
    };

    const transformedCorners: Vector3[] = [];

    for (const original of boxFaces(box, { texture: 0 })) {
      const side = original.side!, data = element.faces[side];
      const physical = apply(original);

      transformedCorners.push(physical.origin, V3.add(physical.origin, physical.u), V3.add(physical.origin, physical.v));

      if (!data) {
        continue;
      }

      const slot = texture(data.texture), uv = data.uv ?? defaultUv(side, element.from, element.to);
      const turn = (data.rotation ?? 0) / 90;

      if (!Number.isInteger(turn)) {
        throw new Error('Non-quarter-turn face UV rotation');
      }

      const point = (u: number, v: number): number[] => {
        for (let i = 0; i < (turn % 4 + 4) % 4; i++) {
          [u, v] = [v, 1 - u];
        }

        return [(uv[0] + u * (uv[2] - uv[0])) / 16, (uv[1] + v * (uv[3] - uv[1])) / 16];
      };

      const f = frame(physical, point(0, 1), point(1, 1), point(0, 0));
      const normalSide = sideOf(cross(f.u, f.v));

      if (normalSide) {
        sides |= 1 << SIDES.indexOf(normalSide);
      }

      slots.add(slot);
      faces.push([f.origin.x, f.origin.y, f.origin.z, f.u.x, f.u.y, f.u.z, f.v.x, f.v.y, f.v.z,
        ...f.uv, slot, data.tintindex ?? -1, 1, SIDES.indexOf(side)].map(round));
    }

    if ((!rotation || rotation.angle % 90 === 0) && transformedCorners.length && element.from.every((n, i) => element.to[i] > n)) {
      const bound = (fn: typeof Math.min): Vector3 => ({ x: fn(...transformedCorners.map(p => p.x)), y: fn(...transformedCorners.map(p => p.y)), z: fn(...transformedCorners.map(p => p.z)) });

      boxes.push({ bounds: boundsOf({ min: bound(Math.min), max: bound(Math.max) }), sides, slots: [...slots] });
    }
  }

  return { faces, boxes };
}

const embed = (side: Side, u: number, v: number): Vector3 => ({
  north: { x: 1 - u, y: 1 - v, z: 0 }, south: { x: u, y: 1 - v, z: 1 },
  east: { x: 1, y: 1 - v, z: 1 - u }, west: { x: 0, y: 1 - v, z: u },
  up: { x: u, y: 1, z: v }, down: { x: u, y: 0, z: 1 - v },
})[side];
const project = (side: Side, p: Vector3): number[] => ({ north: [1 - p.x, 1 - p.y], south: [p.x, 1 - p.y], east: [1 - p.z, 1 - p.y], west: [p.z, 1 - p.y], up: [p.x, p.z], down: [p.x, 1 - p.z] })[side];

export function applyBlockRotation(face: RenderFace, side: Side, x: number, y: number, uvlock: boolean): RenderFace {
  let result = { ...face, origin: V3.add(pivot, blockRotation(V3.subtract(face.origin, pivot), x, y)), u: blockRotation(face.u, x, y), v: blockRotation(face.v, x, y) };

  if (uvlock && (x || y)) {
    const target = sideOf(blockRotation(normalOf(side), x, y));

    if (!target) {
      throw new Error('Non-quarter-turn blockstate rotation');
    }

    const uv = (u: number, v: number): number[] => project(target, V3.add(pivot, blockRotation(V3.subtract(embed(side, u, v), pivot), x, y)));
    const [u, v, w, h] = face.uv;

    result = frame(result, uv(u, v), uv(u + w, v), uv(u, v + h));
  }

  const clean = (p: Vector3): Vector3 => ({ x: round(p.x), y: round(p.y), z: round(p.z) });

  return { ...result, origin: clean(result.origin), u: clean(result.u), v: clean(result.v), uv: [round(result.uv[0]), round(result.uv[1]), round(result.uv[2]), round(result.uv[3])], side: sideOf(cross(result.u, result.v)) };
}

/** A missing cube face is safe only when other opaque elements fully close it. */
export function closedOccluders(geometry: ModelGeometry, opaque: (slot: number) => boolean): number[] {
  let candidates = geometry.boxes.map((box, index) => ({ ...box, index })).filter(box => box.slots.length && box.slots.every(opaque));
  let changed = true;

  while (changed) {
    const next = candidates.filter(box => SIDES.every((side, sideIndex) => {
      if (box.sides & (1 << sideIndex)) {
        return true;
      }

      const f = boxFaces(boxOf(box.bounds), { texture: 0 }).find(face => face.side === side)!;
      const n = normalOf(side), axis = Math.abs(n.x) ? 'x' : Math.abs(n.y) ? 'y' : 'z';
      const ua = Math.abs(f.u.x) ? 'x' : Math.abs(f.u.y) ? 'y' : 'z', va = Math.abs(f.v.x) ? 'x' : Math.abs(f.v.y) ? 'y' : 'z';
      let remaining = [[0, 0, 1, 1]];

      for (const other of candidates) {
        if (other === box) {
          continue;
        }

        const b = boxOf(other.bounds), p = f.origin[axis];

        if (p < b.min[axis] - 1e-7 || p > b.max[axis] + 1e-7 || (n[axis] > 0 ? b.max[axis] <= p + 1e-7 : b.min[axis] >= p - 1e-7)) {
          continue;
        }

        const u0 = Math.min((b.min[ua] - f.origin[ua]) / f.u[ua], (b.max[ua] - f.origin[ua]) / f.u[ua]);
        const u1 = Math.max((b.min[ua] - f.origin[ua]) / f.u[ua], (b.max[ua] - f.origin[ua]) / f.u[ua]);
        const v0 = Math.min((b.min[va] - f.origin[va]) / f.v[va], (b.max[va] - f.origin[va]) / f.v[va]);
        const v1 = Math.max((b.min[va] - f.origin[va]) / f.v[va], (b.max[va] - f.origin[va]) / f.v[va]);

        remaining = remaining.flatMap(([a, b, c, d]) => {
          const l = Math.max(a, u0), r = Math.min(c, u1), t = Math.max(b, v0), end = Math.min(d, v1);

          if (r <= l + 1e-7 || end <= t + 1e-7) {
            return [[a, b, c, d]];
          }

          return [[a, b, l, d], [r, b, c, d], [l, b, r, t], [l, end, r, d]].filter(([x, y, z, w]) => z - x > 1e-7 && w - y > 1e-7);
        });
      }

      return remaining.length === 0;
    }));

    changed = next.length !== candidates.length;
    candidates = next;
  }

  return candidates.map(box => box.index);
}
