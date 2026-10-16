/**
 * Signed distance fields from glyph coverage (research 04 §5.2): a Felzenszwalb–Huttenlocher exact
 * Euclidean distance transform, run on the inside and the outside separately, with sub-pixel edges from
 * anti-aliased coverage (the TinySDF trick). Pure (no DOM), so it is unit-tested in node.
 *
 * Output convention: byte = 255 · clamp(0.5 − d / (2·spread)), d = signed distance in pixels (positive
 * outside). The glyph edge is 0.5, the value reaches 0 at `spread` px outside and 1 at `spread` px inside.
 */

const INF = 1e20;

/** Scratch buffers reused between calls (grown on demand). */
let scratch = { f: new Float64Array(0), z: new Float64Array(0), v: new Uint16Array(0), outer: new Float64Array(0), inner: new Float64Array(0) };

function ensureScratch(w: number, h: number): void {
  const n = Math.max(w, h);
  if (scratch.f.length < n || scratch.outer.length < w * h) {
    const m = Math.max(n, scratch.f.length);
    const a = Math.max(w * h, scratch.outer.length);
    scratch = { f: new Float64Array(m), z: new Float64Array(m + 1), v: new Uint16Array(m), outer: new Float64Array(a), inner: new Float64Array(a) };
  }
}

/** 1D squared distance transform of `grid[offset + i·stride]`, i < length, in place. */
function edt1d(grid: Float64Array, offset: number, stride: number, length: number): void {
  const { f, z, v } = scratch;
  for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride];
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;
  for (let q = 1; q < length; q++) {
    let s: number;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const d = q - r;
    grid[offset + q * stride] = f[r] + d * d;
  }
}

/** 2D squared Euclidean distance transform (columns then rows), in place. */
export function edt(grid: Float64Array, w: number, h: number): void {
  ensureScratch(w, h);
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w);
}

/**
 * SDF bytes from an 8-bit coverage bitmap (`alpha[i]` 0–255, row-major w × h). The bitmap should have a
 * transparent border of at least `spread` px so the field is not clipped.
 */
export function sdfFromAlpha(alpha: ArrayLike<number>, w: number, h: number, spread: number, out = new Uint8Array(w * h)): Uint8Array {
  ensureScratch(w, h);
  const n = w * h;
  const outer = scratch.outer;
  const inner = scratch.inner;
  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255;
    // `outer` seeds are ink pixels (its transform is the distance outside), `inner` seeds are empty pixels.
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      // Sub-pixel edge: the edge sits (0.5 − a) px from the pixel centre.
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, w, h);
  edt(inner, w, h);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    const v = 0.5 - d / (2 * spread);
    out[i] = Math.round(255 * Math.min(1, Math.max(0, v)));
  }
  return out;
}

/** Shelf packer for the glyph atlas: rows of similar height, left to right. Pure. */
export class ShelfPacker {
  private shelves: { y: number; h: number; x: number }[] = [];
  private nextY = 0;

  constructor(public w: number, public h: number, private readonly gap = 1) {}

  /** Top-left of a free w × h rectangle, or null when full. */
  pack(w: number, h: number): { x: number; y: number } | null {
    const gw = w + this.gap, gh = h + this.gap;
    let best: { y: number; h: number; x: number } | null = null;
    for (const s of this.shelves) {
      if (s.h >= gh && s.h <= gh * 1.4 && s.x + gw <= this.w && (!best || s.h < best.h)) best = s;
    }
    if (!best) {
      if (this.nextY + gh > this.h || gw > this.w) return null;
      best = { y: this.nextY, h: gh, x: 0 };
      this.shelves.push(best);
      this.nextY += gh;
    }
    const p = { x: best.x, y: best.y };
    best.x += gw;
    return p;
  }

  /** Grows the packing area (atlas resized; existing positions stay valid). */
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }
}
