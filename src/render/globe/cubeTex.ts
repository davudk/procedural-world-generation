import { dirToFaceXY, FACE_C, FACE_E, FACE_S, faceDir } from '../../shared/cube';

/**
 * Cube-face rasters for the GPU (research 10 §6.2): six faces in one buffer of (n + 2p)² texels per
 * face, where the p-texel border holds the neighbouring face's cells (rotated to this face's axes), so
 * a hand-filtered `texelFetch(tex, ivec3(xy + p, face), 0)` never has to leave its layer. The border
 * follows the generator's halo convention (`padFace` in gen/grid/cube.ts): the texel `d` cells beyond
 * a side at along index t is the mirror cell `d − 1` cells in from the shared edge on the next face.
 *
 * Corners, where three faces meet: the innermost corner texel holds the mean of the three corner cells
 * meeting there, so a bilinear sample at the cube corner is the same mean from all three faces and the
 * terrain mesh has no crack at the 8 corners; the outer corner texels hold the mean of the two
 * adjacent strips, as the generator's halos do.
 */

/** Face sides: x = 0, x = n − 1, y = 0, y = n − 1 (the generator's SIDE_W … SIDE_S). */
export const SIDE_W = 0;
export const SIDE_E = 1;
export const SIDE_N = 2;
export const SIDE_S = 3;

export interface FaceEdge {
  /** Face beyond this side, its side that is shared, and whether the along index reverses. */
  face: number;
  side: number;
  flip: boolean;
}

/** Texels of padding: two, for bilinear sampling with room for one more ring (research 10 §6.2). */
export const PAD = 2;

let edgeTable: FaceEdge[] | null = null;

/** The 24 face edges (face · 4 + side), derived from the shared cube geometry. */
export function faceEdges(): readonly FaceEdge[] {
  if (edgeTable) return edgeTable;
  const out: FaceEdge[] = [];
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  const t = new Float64Array(3);
  const Q = Math.PI / 4;
  for (let f = 0; f < 6; f++) {
    for (let side = 0; side < 4; side++) {
      // Two points on the edge, at along positions near its start and its end, pushed just across it.
      const across = Q * (1 + 1e-6);
      const at = (along: number, o: Float64Array): void => {
        const a = side === SIDE_W ? -across : side === SIDE_E ? across : along;
        const b = side === SIDE_N ? -across : side === SIDE_S ? across : along;
        faceDir(f, a, b, o);
      };
      at(-Q * 0.5, p);
      at(Q * 0.5, q);
      dirToFaceXY(p[0], p[1], p[2], 2, t);
      const g = t[0];
      const pf = [t[1], t[2]];
      dirToFaceXY(q[0], q[1], q[2], 2, t);
      const qf = [t[1], t[2]];
      // The shared side of g is where both points sit on its border (cell coords in [0, 2]).
      const gside = pf[0] < 0.01 && qf[0] < 0.01 ? SIDE_W : pf[0] > 1.99 && qf[0] > 1.99 ? SIDE_E : pf[1] < 0.01 && qf[1] < 0.01 ? SIDE_N : SIDE_S;
      const alongG = (v: number[]): number => (gside === SIDE_W || gside === SIDE_E ? v[1] : v[0]);
      out.push({ face: g, side: gside, flip: alongG(pf) > alongG(qf) });
    }
  }
  return (edgeTable = out);
}

/** Cell index on the face beyond `side` of face f, at along index t and `depth` cells in from the edge. */
export function acrossCell(n: number, f: number, side: number, t: number, depth: number): number {
  const e = faceEdges()[f * 4 + side];
  const a = e.flip ? n - 1 - t : t;
  const d = Math.min(depth, n - 1);
  let x: number;
  let y: number;
  switch (e.side) {
    case SIDE_W: x = d; y = a; break;
    case SIDE_E: x = n - 1 - d; y = a; break;
    case SIDE_N: x = a; y = d; break;
    default: x = a; y = n - 1 - d; break;
  }
  return (e.face * n + y) * n + x;
}

/**
 * Pads six n×n faces (face-major, `ch` interleaved channels per cell) into six (n + 2p)² faces.
 * Returns a Float32Array laid out as a TEXTURE_2D_ARRAY upload (layer = face).
 */
export function padFaces(src: ArrayLike<number>, n: number, p = PAD, ch = 1): Float32Array {
  const m = n + 2 * p;
  const out = new Float32Array(6 * m * m * ch);
  const n2 = n * n;
  for (let f = 0; f < 6; f++) {
    const base = f * m * m;
    const put = (x: number, y: number, cell: number): void => {
      const o = (base + y * m + x) * ch;
      for (let c = 0; c < ch; c++) out[o + c] = src[cell * ch + c];
    };
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) put(x + p, y + p, f * n2 + y * n + x);
    for (let d = 1; d <= p; d++) {
      for (let t = 0; t < n; t++) {
        put(p - d, p + t, acrossCell(n, f, SIDE_W, t, d - 1));
        put(p + n - 1 + d, p + t, acrossCell(n, f, SIDE_E, t, d - 1));
        put(p + t, p - d, acrossCell(n, f, SIDE_N, t, d - 1));
        put(p + t, p + n - 1 + d, acrossCell(n, f, SIDE_S, t, d - 1));
      }
    }
    const at = (x: number, y: number, c: number): number => out[(base + y * m + x) * ch + c];
    const set = (x: number, y: number, c: number, v: number): void => {
      out[(base + y * m + x) * ch + c] = v;
    };
    const lo = p;
    const hi = p + n - 1;
    for (let dy = 1; dy <= p; dy++) {
      for (let dx = 1; dx <= p; dx++) {
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const cx = sx < 0 ? lo : hi;
          const cy = sy < 0 ? lo : hi;
          const x = cx + sx * dx;
          const y = cy + sy * dy;
          for (let c = 0; c < ch; c++) {
            // Strip texels in the same column / row as the corner texel.
            const a = at(x, cy, c);
            const b = at(cx, y, c);
            set(x, y, c, dx === 1 && dy === 1 ? (a + b + at(cx, cy, c)) / 3 : 0.5 * (a + b));
          }
        }
      }
    }
  }
  return out;
}

/** Face, continuous face-angle coordinates (a, b ∈ [−π/4, π/4]) of a direction. */
export function dirToFaceAngles(x: number, y: number, z: number, out: Float64Array): void {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const face = ax >= ay && ax >= az ? (x > 0 ? 0 : 2) : ay >= az ? (y > 0 ? 1 : 3) : z > 0 ? 4 : 5;
  const f = face * 3;
  const dc = x * FACE_C[f] + y * FACE_C[f + 1] + z * FACE_C[f + 2];
  out[0] = face;
  out[1] = Math.atan((x * FACE_E[f] + y * FACE_E[f + 1] + z * FACE_E[f + 2]) / dc);
  out[2] = Math.atan((x * FACE_S[f] + y * FACE_S[f + 1] + z * FACE_S[f + 2]) / dc);
}

/** Uploads padded faces as a 6-layer R32F / RGBA16F / RGBA8 texture array (nearest filtering unless `linear`). */
export function uploadArray(
  gl: WebGL2RenderingContext, tex: WebGLTexture, data: ArrayBufferView, m: number,
  fmt: 'r32f' | 'rgba16f' | 'rgba8', linear = false,
): void {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const [internal, format, type] =
    fmt === 'r32f' ? [gl.R32F, gl.RED, gl.FLOAT] : fmt === 'rgba16f' ? [gl.RGBA16F, gl.RGBA, gl.FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, internal, m, m, 6, 0, format, type, data);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** A 1×1×6 placeholder texture array (so samplers are always complete). */
export function arrayTexture(gl: WebGL2RenderingContext, fmt: 'r32f' | 'rgba16f' | 'rgba8'): WebGLTexture {
  const t = gl.createTexture();
  uploadArray(gl, t, fmt === 'rgba8' ? new Uint8Array(24) : new Float32Array(fmt === 'r32f' ? 6 : 24), 1, fmt);
  return t;
}
