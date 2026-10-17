/**
 * Equal-angle (equiangular) cube-sphere geometry (research 10 §1.3), shared by the generator's cube
 * grid and the main thread's map projections. Face f has centre c, right axis e (+x, columns) and
 * down axis s (+y, rows); seen from outside the planet e points right and s down, so e × s = −c.
 * Faces 0–3 ring the equator with row 0 toward the north pole (+z); face 4 is the north polar face,
 * face 5 the south one.
 *
 * A cell (x, y) of an n×n face has its centre at the angles a = (x + ½)Δ − π/4, b = (y + ½)Δ − π/4,
 * Δ = (π/2)/n; the cube point c + tan(a)·e + tan(b)·s, normalised, is its unit vector.
 */

const AXES: readonly (readonly [readonly number[], readonly number[], readonly number[]])[] = [
  [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[0, 1, 0], [-1, 0, 0], [0, 0, -1]],
  [[-1, 0, 0], [0, -1, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, 0, 1], [0, 1, 0], [1, 0, 0]],
  [[0, 0, -1], [0, 1, 0], [-1, 0, 0]],
];

/** Face centre, right and down axes, 3 components per face. */
export const FACE_C = Float64Array.from(AXES.flatMap((a) => a[0]));
export const FACE_E = Float64Array.from(AXES.flatMap((a) => a[1]));
export const FACE_S = Float64Array.from(AXES.flatMap((a) => a[2]));

const QUARTER = Math.PI / 4;

/** Unit vector of face angles (a, b) on `face`, written to out[o..o+2]. */
export function faceDir(face: number, a: number, b: number, out: Float64Array | Float32Array, o = 0): void {
  const X = Math.tan(a);
  const Y = Math.tan(b);
  const f = face * 3;
  const x = FACE_C[f] + X * FACE_E[f] + Y * FACE_S[f];
  const y = FACE_C[f + 1] + X * FACE_E[f + 1] + Y * FACE_S[f + 1];
  const z = FACE_C[f + 2] + X * FACE_E[f + 2] + Y * FACE_S[f + 2];
  const inv = 1 / Math.sqrt(1 + X * X + Y * Y);
  out[o] = x * inv;
  out[o + 1] = y * inv;
  out[o + 2] = z * inv;
}

/** Face a direction (not necessarily unit) falls on: the axis of its largest component. */
export function dirFace(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? 0 : 2;
  if (ay >= az) return y > 0 ? 1 : 3;
  return z > 0 ? 4 : 5;
}

/**
 * Face and continuous cell coordinates of a direction on an n×n cube grid: out = [face, fx, fy] with
 * the cell centres at integer + ½ (fx ∈ [0, n]).
 */
export function dirToFaceXY(x: number, y: number, z: number, n: number, out: Float64Array): void {
  const face = dirFace(x, y, z);
  const f = face * 3;
  const dc = x * FACE_C[f] + y * FACE_C[f + 1] + z * FACE_C[f + 2];
  const X = (x * FACE_E[f] + y * FACE_E[f + 1] + z * FACE_E[f + 2]) / dc;
  const Y = (x * FACE_S[f] + y * FACE_S[f + 1] + z * FACE_S[f + 2]) / dc;
  const k = n / (2 * QUARTER);
  out[0] = face;
  out[1] = (Math.atan(X) + QUARTER) * k;
  out[2] = (Math.atan(Y) + QUARTER) * k;
}

const scratch = new Float64Array(3);

/** Cell index (face-major, row-major in a face) containing a direction on an n×n cube grid. */
export function dirToCell(x: number, y: number, z: number, n: number): number {
  dirToFaceXY(x, y, z, n, scratch);
  const cx = Math.min(n - 1, Math.max(0, Math.floor(scratch[1])));
  const cy = Math.min(n - 1, Math.max(0, Math.floor(scratch[2])));
  return (scratch[0] * n + cy) * n + cx;
}

/** Unit vector of latitude / longitude (degrees; polar axis +z, longitude 0 toward +x). */
export function latLonDir(latDeg: number, lonDeg: number, out: Float64Array): void {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  out[0] = Math.cos(la) * Math.cos(lo);
  out[1] = Math.cos(la) * Math.sin(lo);
  out[2] = Math.sin(la);
}

/**
 * Sphere positions in generator outputs (river nodes, lakes, landform features, later landmarks) are
 * (face, u, v): the face index plus face-local metres along its columns (u) and rows (v) in the
 * equal-angle convention of the grid's `SurfacePoint`, u = (a + π/4)·R, so cell (x, y) of an n×n face
 * has its centre at u = (x + ½)·cellM, v = (y + ½)·cellM with cellM = (π/2)·R/n. On flat maps the
 * same fields are map metres from the north-west corner and the face is 0 (absent).
 */
export function surfaceDir(face: number, u: number, v: number, radiusM: number, out: Float64Array | Float32Array, o = 0): void {
  faceDir(face, u / radiusM - QUARTER, v / radiusM - QUARTER, out, o);
}

/** (face, u, v) of a direction (any length) on a sphere of `radiusM`: out = [face, u, v]. */
export function dirSurface(x: number, y: number, z: number, radiusM: number, out: Float64Array): void {
  const face = dirFace(x, y, z);
  const f = face * 3;
  const dc = x * FACE_C[f] + y * FACE_C[f + 1] + z * FACE_C[f + 2];
  out[0] = face;
  out[1] = (Math.atan((x * FACE_E[f] + y * FACE_E[f + 1] + z * FACE_E[f + 2]) / dc) + QUARTER) * radiusM;
  out[2] = (Math.atan((x * FACE_S[f] + y * FACE_S[f + 1] + z * FACE_S[f + 2]) / dc) + QUARTER) * radiusM;
}

/** Latitude and longitude (degrees) of a surface position: out = [lat, lon]. */
export function surfaceLatLon(face: number, u: number, v: number, radiusM: number, out: Float64Array): void {
  surfaceDir(face, u, v, radiusM, scratch);
  out[0] = (Math.asin(Math.max(-1, Math.min(1, scratch[2]))) * 180) / Math.PI;
  out[1] = (Math.atan2(scratch[1], scratch[0]) * 180) / Math.PI;
}
