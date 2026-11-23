/** Structural vectors and orientations shared by model transforms and rendering drivers. */
export interface Vector3 { x: number; y: number; z: number }

export interface Quaternion { x: number; y: number; z: number; w: number }

/** Allocation-based vector helpers for geometry and binding code. */
export const V3 = {
  add(a: Vector3, b: Vector3): Vector3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  },

  subtract(a: Vector3, b: Vector3): Vector3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  },

  scale(v: Vector3, s: number): Vector3 {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
  },

  dot(a: Vector3, b: Vector3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },

  cross(a: Vector3, b: Vector3): Vector3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  },

  length(v: Vector3): number {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  },

  normalize(v: Vector3): Vector3 {
    const len = V3.length(v);

    return len === 0 ? { x: 0, y: 0, z: 0 } : V3.scale(v, 1 / len);
  },

  distance(a: Vector3, b: Vector3): number {
    return V3.length(V3.subtract(a, b));
  },

  clone(v: Vector3): Vector3 {
    return { x: v.x, y: v.y, z: v.z };
  },
} as const;

const RAD_TO_DEG = 180 / Math.PI;

export const Quat = {
  identity(): Quaternion {
    return { x: 0, y: 0, z: 0, w: 1 };
  },

  multiply(a: Quaternion, b: Quaternion): Quaternion {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    };
  },

  fromAxisAngle(axis: Vector3, angle: number): Quaternion {
    const len = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);

    if (len === 0) {
      return { x: 0, y: 0, z: 0, w: 1 };
    }

    const half = angle * 0.5;
    const s = Math.sin(half) / len;

    return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
  },

  rotateVector(q: Quaternion, v: Vector3): Vector3 {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);

    return {
      x: v.x + q.w * tx + (q.y * tz - q.z * ty),
      y: v.y + q.w * ty + (q.z * tx - q.x * tz),
      z: v.z + q.w * tz + (q.x * ty - q.y * tx),
    };
  },

  fromEuler(e: Vector3): Quaternion {
    const d2r = Math.PI / 180;
    const rx = Quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, e.x * d2r);
    const ry = Quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, e.y * d2r);
    const rz = Quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, e.z * d2r);

    return Quat.multiply(Quat.multiply(rz, ry), rx);
  },

  toEuler(q: Quaternion): Vector3 {
    const { x, y, z, w } = q;
    const siny = 2 * (w * y - x * z); // sin(yaw) — yaw is the middle axis

    // Gimbal lock at yaw = ±90°: pitch and roll share an axis. Fold the remaining DOF into pitch
    // (roll = 0) with the closed form for this convention so the result still reconstructs.
    const m01 = 2 * (x * y - w * z);
    const m02 = 2 * (x * z + w * y);

    if (siny >= 1 - 1e-6) {
      return { x: Math.atan2(m01, m02) * RAD_TO_DEG, y: 90, z: 0 };
    }

    if (siny <= -1 + 1e-6) {
      return { x: Math.atan2(-m01, -m02) * RAD_TO_DEG, y: -90, z: 0 };
    }

    const yaw = Math.asin(siny);
    const pitch = Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + y * y));
    const roll = Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z));

    return { x: pitch * RAD_TO_DEG, y: yaw * RAD_TO_DEG, z: roll * RAD_TO_DEG };
  },
} as const;
