import type { Vec3 } from '../camera/ground';

/** Column-major 4×4 matrix: element (row r, column c) is m[c * 4 + r]. */
export type Mat4 = Float32Array | Float64Array;

export function mat4(): Float64Array {
  return identity(new Float64Array(16));
}

export function identity<T extends Mat4>(out: T): T {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

const tmp = new Float64Array(16);

/** out = a · b (b is applied first). `out` may alias `a` or `b`. */
export function mul<T extends Mat4>(out: T, a: Mat4, b: Mat4): T {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      tmp[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  out.set(tmp);
  return out;
}

/** OpenGL perspective: view-space z ∈ [−near, −far] → NDC depth [−1, 1]. */
export function perspective<T extends Mat4>(out: T, fovY: number, aspect: number, near: number, far: number): T {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * Reversed-Z perspective with an infinite far plane for `EXT_clip_control` ZERO_TO_ONE: depth = near / −z_view,
 * so the near plane maps to 1 and infinity to 0 (clear depth to 0, depthFunc GEQUAL).
 */
export function perspectiveReversedInfinite<T extends Mat4>(out: T, fovY: number, aspect: number, near: number): T {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = near;
  return out;
}

/** Right-handed view matrix: camera at `eye` looking at `center`, `up` projected to the screen's up. */
export function lookAt<T extends Mat4>(out: T, eye: Vec3, center: Vec3, up: Vec3): T {
  let fx = center.x - eye.x, fy = center.y - eye.y, fz = center.z - eye.z;
  let l = Math.hypot(fx, fy, fz);
  fx /= l; fy /= l; fz /= l;
  // s = f × up
  let sx = fy * up.z - fz * up.y, sy = fz * up.x - fx * up.z, sz = fx * up.y - fy * up.x;
  l = Math.hypot(sx, sy, sz);
  sx /= l; sy /= l; sz /= l;
  // u = s × f
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = sz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(sx * eye.x + sy * eye.y + sz * eye.z);
  out[13] = -(ux * eye.x + uy * eye.y + uz * eye.z);
  out[14] = fx * eye.x + fy * eye.y + fz * eye.z;
  out[15] = 1;
  return out;
}

/** General inverse; returns null when singular. `out` may alias `m`. */
export function invert<T extends Mat4>(out: T, m: Mat4): T | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const k = 1 / det;
  tmp[0] = (a11 * b11 - a12 * b10 + a13 * b09) * k;
  tmp[1] = (a02 * b10 - a01 * b11 - a03 * b09) * k;
  tmp[2] = (a31 * b05 - a32 * b04 + a33 * b03) * k;
  tmp[3] = (a22 * b04 - a21 * b05 - a23 * b03) * k;
  tmp[4] = (a12 * b08 - a10 * b11 - a13 * b07) * k;
  tmp[5] = (a00 * b11 - a02 * b08 + a03 * b07) * k;
  tmp[6] = (a32 * b02 - a30 * b05 - a33 * b01) * k;
  tmp[7] = (a20 * b05 - a22 * b02 + a23 * b01) * k;
  tmp[8] = (a10 * b10 - a11 * b08 + a13 * b06) * k;
  tmp[9] = (a01 * b08 - a00 * b10 - a03 * b06) * k;
  tmp[10] = (a30 * b04 - a31 * b02 + a33 * b00) * k;
  tmp[11] = (a21 * b02 - a20 * b04 - a23 * b00) * k;
  tmp[12] = (a11 * b07 - a10 * b09 - a12 * b06) * k;
  tmp[13] = (a00 * b09 - a01 * b07 + a02 * b06) * k;
  tmp[14] = (a31 * b01 - a30 * b03 - a32 * b00) * k;
  tmp[15] = (a20 * b03 - a21 * b01 + a22 * b00) * k;
  out.set(tmp);
  return out;
}

/** m · (x, y, z, w) into `out` (length ≥ 4). */
export function transform4(out: Float64Array, m: Mat4, x: number, y: number, z: number, w = 1): Float64Array {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

const v4 = new Float64Array(4);

/** Inverse of a projection: NDC (x, y, z) through `invViewProj` back to a point (perspective divide applied). */
export function unproject(invViewProj: Mat4, ndcX: number, ndcY: number, ndcZ: number): Vec3 {
  transform4(v4, invViewProj, ndcX, ndcY, ndcZ, 1);
  return { x: v4[0] / v4[3], y: v4[1] / v4[3], z: v4[2] / v4[3] };
}
