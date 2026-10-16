/**
 * Glacier corridors: a U cross-section evaluated per cell from its distance to a continuous glacier
 * centreline, instead of a union of per-cell circular stamps (whose overlapping rims leave scallops
 * along the walls).
 *
 * The centreline is a polyline: each source is a vertex (sub-cell position, smoothed along the trunk
 * by the caller) linked to its downstream vertex, and every link is a segment along which floor, edge
 * height, half-width and cut limit are interpolated linearly. A cell inside a segment's tube gets
 * profile = floor + (edge − floor)·t², t = distance to the segment / half-width, and the corridor is
 * the lower envelope of all tubes (a smooth swept parabola, joining tributaries without seams).
 */
export class CorridorSources {
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly floor: number[] = [];
  readonly edge: number[] = [];
  /** Half-width in cells. */
  readonly rc: number[] = [];
  readonly cut: number[] = [];
  /** Downstream vertex (source index), or −1 for an isolated point / the line end. */
  readonly next: number[] = [];

  add(x: number, y: number, floor: number, edge: number, rc: number, cut: number): number {
    this.x.push(x);
    this.y.push(y);
    this.floor.push(floor);
    this.edge.push(edge);
    this.rc.push(rc);
    this.cut.push(cut);
    this.next.push(-1);
    return this.x.length - 1;
  }

  get size(): number {
    return this.x.length;
  }
}

export interface CorridorField {
  /** Metres removed: max(0, h − profile), never more than the interpolated cut limit. */
  carve: Float32Array;
  /** Half-width (cells) of the widest tube covering the cell; 0 outside every corridor. */
  rc: Float32Array;
}

/** Carve field of a centreline polyline over `h`. Sea (fixed) cells are skipped unless `sea`. */
export function corridorCarve(src: CorridorSources, h: Float32Array, fixed: Uint8Array, n: number, sea: boolean): CorridorField {
  const N = n * n;
  const target = new Float32Array(N).fill(Infinity);
  const rcOut = new Float32Array(N);
  const { x: X, y: Y, floor: F, edge: E, rc: R, cut: C, next } = src;
  for (let s = 0; s < src.size; s++) {
    const e = next[s] >= 0 ? next[s] : s;
    const ax = X[s];
    const ay = Y[s];
    const bx = X[e] - ax;
    const by = Y[e] - ay;
    const len2 = bx * bx + by * by;
    const rMax = Math.max(R[s], R[e]);
    const x0 = Math.max(0, Math.floor(Math.min(ax, ax + bx) - rMax));
    const x1 = Math.min(n - 1, Math.ceil(Math.max(ax, ax + bx) + rMax));
    const y0 = Math.max(0, Math.floor(Math.min(ay, ay + by) - rMax));
    const y1 = Math.min(n - 1, Math.ceil(Math.max(ay, ay + by) + rMax));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * n + x;
        if (fixed[i] && !sea) continue;
        const px = x - ax;
        const py = y - ay;
        let u = len2 > 0 ? (px * bx + py * by) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = px - u * bx;
        const dy = py - u * by;
        const rc = R[s] + u * (R[e] - R[s]);
        const t2 = (dx * dx + dy * dy) / (rc * rc);
        if (t2 > 1) continue;
        const fl = F[s] + u * (F[e] - F[s]);
        const ed = E[s] + u * (E[e] - E[s]);
        const cut = C[s] + u * (C[e] - C[s]);
        let v = fl + (ed - fl) * t2;
        if (v < h[i] - cut) v = h[i] - cut;
        if (v < target[i]) target[i] = v;
        if (rc > rcOut[i]) rcOut[i] = rc;
      }
    }
  }
  const carve = new Float32Array(N);
  for (let i = 0; i < N; i++) if (target[i] < h[i]) carve[i] = h[i] - target[i];
  return { carve, rc: rcOut };
}

/**
 * Softens a carve field (binomial 1-2-1 twice per axis, σ ≈ 1 cell), blended in by corridor width:
 * none for corridors ≤ 1 cell wide (it would fill single-cell channels), full from 3 cells. Values
 * stay ≥ 0, so applying the result still only lowers terrain.
 */
export function softenCarve(carve: Float32Array, rc: Float32Array, n: number): Float32Array {
  const N = n * n;
  const a = carve.slice();
  const tmp = new Float32Array(N);
  // Rows within 3 of any carving; everything else stays 0 and is skipped.
  const has = new Uint8Array(n);
  for (let i = 0; i < N; i++) if (carve[i] > 0) has[(i / n) | 0] = 1;
  const active = new Uint8Array(n);
  for (let y = 0; y < n; y++) if (has[y]) for (let k = Math.max(0, y - 3); k <= Math.min(n - 1, y + 3); k++) active[k] = 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < n; y++) {
      if (!active[y]) continue;
      const row = y * n;
      for (let x = 0; x < n; x++) {
        const l = x > 0 ? a[row + x - 1] : a[row + x];
        const r = x < n - 1 ? a[row + x + 1] : a[row + x];
        tmp[row + x] = 0.25 * l + 0.5 * a[row + x] + 0.25 * r;
      }
    }
    for (let y = 0; y < n; y++) {
      if (!active[y]) continue;
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const u = y > 0 ? tmp[i - n] : tmp[i];
        const d = y < n - 1 ? tmp[i + n] : tmp[i];
        a[i] = 0.25 * u + 0.5 * tmp[i] + 0.25 * d;
      }
    }
  }
  // Blend weight from the widest corridor in the 3×3 neighbourhood (separable max), so rims next to
  // wide troughs soften too.
  const wRow = new Float32Array(N);
  for (let y = 0; y < n; y++) {
    if (!active[y]) continue;
    const row = y * n;
    for (let x = 0; x < n; x++) {
      let w = rc[row + x];
      if (x > 0 && rc[row + x - 1] > w) w = rc[row + x - 1];
      if (x < n - 1 && rc[row + x + 1] > w) w = rc[row + x + 1];
      wRow[row + x] = w;
    }
  }
  for (let i = 0; i < N; i++) {
    if (a[i] === 0 && carve[i] === 0) continue;
    let w = wRow[i];
    if (i >= n && wRow[i - n] > w) w = wRow[i - n];
    if (i < N - n && wRow[i + n] > w) w = wRow[i + n];
    const t = Math.min(1, Math.max(0, (w - 1) / 2));
    const al = t * t * (3 - 2 * t);
    a[i] = carve[i] + al * (a[i] - carve[i]);
  }
  return a;
}
