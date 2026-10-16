/**
 * Climate on the cube-sphere (research 10 §5.6): local wind frames, east–west coastline distances on
 * a closed surface and the upwind sweep order. The flat model keeps its own row sweeps and quadrant
 * orders; these replace them only when the grid is a cube-sphere.
 */
import { FACE_E, FACE_S } from '../../shared/cube';
import { localFrame, unitPositions, type CubeGrid } from '../grid/cube';

const axesCache = new WeakMap<CubeGrid, Float32Array>();

/**
 * Per cell, the local east and north unit vectors projected on the face's +x (columns) and +y (rows)
 * directions: [E·x̂, N·x̂, E·ŷ, N·ŷ]. A tangent vector w = we·E + wn·N has face components
 * gx = we·[0] + wn·[1], gy = we·[2] + wn·[3] (projection; the face axes are orthogonal except near the
 * cube corners).
 */
export function faceAxes(g: CubeGrid): Float32Array {
  let a = axesCache.get(g);
  if (a) return a;
  a = new Float32Array(g.cells * 4);
  const p = unitPositions(g);
  const up = new Float64Array(3);
  const east = new Float64Array(3);
  const north = new Float64Array(3);
  const tx = new Float64Array(3);
  const ty = new Float64Array(3);
  for (let i = 0; i < g.cells; i++) {
    const f = Math.floor(i / g.n2) * 3;
    up[0] = p[i * 3];
    up[1] = p[i * 3 + 1];
    up[2] = p[i * 3 + 2];
    localFrame(up, east, north);
    tangent(FACE_E, f, up, tx);
    tangent(FACE_S, f, up, ty);
    a[i * 4] = dot(east, tx);
    a[i * 4 + 1] = dot(north, tx);
    a[i * 4 + 2] = dot(east, ty);
    a[i * 4 + 3] = dot(north, ty);
  }
  axesCache.set(g, a);
  return a;
}

/** Unit tangent at `up` of the face axis ax[f..f+2] (its component orthogonal to up). */
function tangent(ax: Float64Array, f: number, up: Float64Array, out: Float64Array): void {
  const d = ax[f] * up[0] + ax[f + 1] * up[1] + ax[f + 2] * up[2];
  out[0] = ax[f] - d * up[0];
  out[1] = ax[f + 1] - d * up[1];
  out[2] = ax[f + 2] - d * up[2];
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= len;
  out[1] /= len;
  out[2] /= len;
}

function dot(a: Float64Array, b: Float64Array): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Converts winds given as (east, south) components — the flat convention of `windField`, gx east,
 * gy = −north — into face-axis components in place.
 */
export function windToFace(g: CubeGrid, gx: Float32Array, gy: Float32Array): void {
  const a = faceAxes(g);
  for (let i = 0; i < g.cells; i++) {
    const we = gx[i];
    const wn = -gy[i];
    gx[i] = we * a[i * 4] + wn * a[i * 4 + 1];
    gy[i] = we * a[i * 4 + 2] + wn * a[i * 4 + 3];
  }
}

const succCache = new WeakMap<CubeGrid, { east: Int32Array; west: Int32Array }>();

/** Per cell, the neighbour most nearly due east and due west (the steps of a parallel). */
export function eastWest(g: CubeGrid): { east: Int32Array; west: Int32Array } {
  let s = succCache.get(g);
  if (s) return s;
  const p = unitPositions(g);
  const east = new Int32Array(g.cells);
  const west = new Int32Array(g.cells);
  const up = new Float64Array(3);
  const e = new Float64Array(3);
  const nn = new Float64Array(3);
  for (let i = 0; i < g.cells; i++) {
    up[0] = p[i * 3];
    up[1] = p[i * 3 + 1];
    up[2] = p[i * 3 + 2];
    localFrame(up, e, nn);
    let bestE = -2;
    let bestW = 2;
    east[i] = west[i] = i;
    for (let k = 0; k < 8; k++) {
      const j = g.nbr(i, k);
      if (j < 0) continue;
      const dx = p[j * 3] - up[0];
      const dy = p[j * 3 + 1] - up[1];
      const dz = p[j * 3 + 2] - up[2];
      const c = (dx * e[0] + dy * e[1] + dz * e[2]) / (Math.hypot(dx, dy, dz) || 1);
      if (c > bestE) {
        bestE = c;
        east[i] = j;
      }
      if (c < bestW) {
        bestW = c;
        west[i] = j;
      }
    }
  }
  s = { east, west };
  succCache.set(g, s);
  return s;
}

/**
 * Distance (km) from every sea cell to the first land cell along a chain of steps (east or west
 * neighbours), capped at `farKm`; 0 on land. Each chain is walked once and memoised; a chain that
 * closes on itself (an all-sea parallel) or runs past the cap is `farKm`.
 */
export function distanceAlong(g: CubeGrid, sea: Uint8Array, succ: Int32Array, farKm: number): Float64Array {
  const N = g.cells;
  const d = new Float64Array(N).fill(-1);
  const onPath = new Int32Array(N);
  const path: number[] = [];
  const cap = Math.ceil(farKm / (0.7 * g.cellKm)) + 2;
  for (let s = 0; s < N; s++) {
    if (!sea[s]) d[s] = 0;
  }
  for (let s = 0; s < N; s++) {
    if (d[s] >= 0) continue;
    path.length = 0;
    let j = s;
    while (d[j] < 0 && onPath[j] !== s + 1 && path.length < cap) {
      onPath[j] = s + 1;
      path.push(j);
      j = succ[j];
    }
    let v = d[j] >= 0 && onPath[j] !== s + 1 ? d[j] : farKm;
    for (let k = path.length - 1; k >= 0; k--) {
      const c = path[k];
      v = Math.min(farKm, v + g.distance(c, k + 1 < path.length ? path[k + 1] : j) / 1000);
      d[c] = v;
    }
  }
  return d;
}

/**
 * Sweep order for a closed surface: a depth-first topological order of the upwind graph (each cell
 * after its ≤ 2 upwind neighbours). Edges that close a loop — the westerlies round a hemisphere — are
 * simply met in progress and skipped, so those cells read the previous round's value; the decay
 * along each path makes the rounds converge (research 10 §5.6).
 */
export function upwindOrder(iu: Int32Array, ju: Int32Array): Int32Array {
  const N = iu.length;
  const state = new Uint8Array(N);
  const order = new Int32Array(N);
  const stack = new Int32Array(N * 3 + 1);
  let k = 0;
  for (let root = 0; root < N; root++) {
    if (state[root]) continue;
    let top = 0;
    stack[top++] = root;
    while (top > 0) {
      const c = stack[top - 1];
      if (state[c] === 0) {
        state[c] = 1;
        const a = iu[c];
        const b = ju[c];
        if (b >= 0 && b !== c && state[b] === 0) stack[top++] = b;
        if (a >= 0 && a !== c && state[a] === 0) stack[top++] = a;
      } else {
        top--;
        if (state[c] === 1) {
          state[c] = 2;
          order[k++] = c;
        }
      }
    }
  }
  return order;
}
