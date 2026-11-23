import { Quat, V3 } from './math.ts';
import { boxFaces, boxUvRects } from './faces.ts';
import type { PackedFace, Triple, Vector3 } from './types.ts';

type Matrix = number[];
export interface EntityPart {
  texture?: [number, number];
  pose: { offset: Triple; rotation: Triple; scale?: Triple };
  cubes: { origin: Triple; size: Triple; uv: [number, number]; grow?: Triple; mirror?: boolean; uvScale?: [number, number]; visibleFaces?: string[] }[];
  children: Record<string, EntityPart>;
}

export interface ExtractedEntityModel {
  id: string;
  transform: { translate?: Triple; rotate?: Triple; scale?: Triple }[];
  layers: Record<string, { texture: [number, number]; textureLocation?: string; render?: string; root: EntityPart }>;
}

export interface EntityBoneFaces { name: string; parent?: string; pivot: number[]; faces: PackedFace[] }

const identity = (): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const values = (v: Vector3): number[] => [v.x, v.y, v.z];
const point = (m: Matrix, v: Vector3): Vector3 => ({ x: m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3], y: m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7], z: m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11] });
const direction = (m: Matrix, v: Vector3): Vector3 => V3.subtract(point(m, v), point(m, { x: 0, y: 0, z: 0 }));

const multiply = (a: Matrix, b: Matrix): Matrix => {
  const at = (r: number, c: number): number => a[r] * b[c] + a[r + 1] * b[c + 4] + a[r + 2] * b[c + 8];

  return [at(0, 0), at(0, 1), at(0, 2), at(0, 3) + a[3], at(4, 0), at(4, 1), at(4, 2), at(4, 3) + a[7], at(8, 0), at(8, 1), at(8, 2), at(8, 3) + a[11]];
};

const transform = (offset: Triple = [0, 0, 0], rotation: Triple = [0, 0, 0], scale: Triple = [1, 1, 1]): Matrix => {
  const q = Quat.fromEuler({ x: rotation[0] * 180 / Math.PI, y: rotation[1] * 180 / Math.PI, z: rotation[2] * 180 / Math.PI });
  const x = Quat.rotateVector(q, { x: scale[0], y: 0, z: 0 }), y = Quat.rotateVector(q, { x: 0, y: scale[1], z: 0 }), z = Quat.rotateVector(q, { x: 0, y: 0, z: scale[2] });

  return [x.x, y.x, z.x, offset[0], x.y, y.y, z.y, offset[1], x.z, y.z, z.z, offset[2]];
};

const round = (value: number): number => Math.abs(value) < 1e-7 ? 0 : Math.round(value * 1e7) / 1e7;

/** Bake an extracted rest pose into the shared block-face coordinates while retaining named joints. */
export function entityModelFaces(model: ExtractedEntityModel, layerName: string, { rotation = 0, translation = [0, 0, 0], entity = false }: { rotation?: number; translation?: Triple; entity?: boolean } = {}): EntityBoneFaces[] {
  const layer = model.layers[layerName];

  if (!layer) {
    throw new Error(`Missing entity layer: ${model.id}/${layerName}`);
  }

  let matrix = identity();

  if (!entity) {
    matrix = multiply(transform([8, 0, 8], [0, rotation * Math.PI / 180, 0]), transform([-8, 0, -8]));
    matrix = multiply(matrix, transform(translation));
  }

  for (const operation of model.transform) {
    matrix = multiply(matrix, transform(operation.translate, operation.rotate, operation.scale));
  }

  const bones: EntityBoneFaces[] = [];

  const visit = (part: EntityPart, parent: Matrix, path: string, parentName?: string, texture = layer.texture): void => {
    const current = multiply(parent, transform(part.pose.offset, part.pose.rotation, part.pose.scale));
    const name = `${model.id.replace(/^minecraft:/, '').replaceAll('/', '_')}_${layerName}_${path}`;
    const at = point(current, { x: 0, y: 0, z: 0 });
    const bone: EntityBoneFaces = { name, ...(parentName ? { parent: parentName } : {}), pivot: [at.x - (entity ? 0 : 8), at.y, (entity ? 0 : 8) - at.z].map(round), faces: [] };

    texture = part.texture ?? texture;
    bones.push(bone);

    for (const cube of part.cubes) {
      if (cube.uvScale) {
        throw new Error(`Unsupported entity cube UV scale: ${model.id}/${layerName}/${path}`);
      }

      const [dx, dy, dz] = cube.size, grow = cube.grow ?? [0, 0, 0];
      const origin = { x: cube.origin[0] - 8 - grow[0], y: cube.origin[1] - grow[1], z: 8 - cube.origin[2] - dz - grow[2] };
      const end = { x: origin.x + dx + grow[0] * 2, y: origin.y + dy + grow[1] * 2, z: origin.z + dz + grow[2] * 2 };
      const rectangles = boxUvRects(cube.size, cube.uv, cube.mirror);

      for (const face of boxFaces({ min: origin, max: end }, { texture: 0 })) {
        const side = face.side === 'east' ? 'west' : face.side === 'west' ? 'east' : face.side!;

        if (cube.visibleFaces && !cube.visibleFaces.includes(side)) {
          continue;
        }

        const cap = side === 'up' || side === 'down';
        const localOrigin = cap ? face.origin : V3.add(face.origin, V3.add(face.u, face.v));
        const localU = cap ? face.u : V3.scale(face.u, -1), localV = cap ? face.v : V3.scale(face.v, -1);
        const rect = rectangles[side];

        const reflect = (p: Vector3): Vector3 => ({ x: p.x, y: p.y, z: -p.z });
        const source = V3.add(reflect(V3.add(localOrigin, localU)), { x: 8, y: 0, z: 8 });
        const target = point(current, source), targetU = direction(current, V3.scale(reflect(localU), -1)), targetV = direction(current, reflect(localV));
        const offset = entity ? { x: 8, y: 0, z: 8 } : { x: 0, y: 0, z: 0 };

        bone.faces.push([...values(V3.scale(V3.add(target, offset), 1 / 16)), ...values(V3.scale(targetU, 1 / 16)), ...values(V3.scale(targetV, 1 / 16)),
          (rect[0] + rect[2]) / texture[0], (rect[1] + rect[3]) / texture[1], -rect[2] / texture[0], -rect[3] / texture[1], 0, -1, 0, ['north', 'south', 'east', 'west', 'up', 'down'].indexOf(side)]);
      }
    }

    for (const [child, value] of Object.entries(part.children)) {
      visit(value, current, `${path}_${child}`, name, texture);
    }
  };

  visit(layer.root, matrix, 'root');

  return bones;
}
