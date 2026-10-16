import type { Layer } from '../shared/protocol';
import type { GroundQuery, Vec3 } from './camera/ground';

/**
 * CPU copy of the elevation raster for picking, culling and camera clamps (research 04 §7.2).
 * Rendered height = max(h, 0) × exaggeration: the "water lid" puts the sea surface at 0, exactly as
 * the terrain shader does, so picking and rendering agree.
 */
export class HeightField implements GroundQuery {
  readonly size: number;
  readonly n: number;
  readonly cell: number;
  /** Raw elevation in metres, row 0 = north. */
  readonly data: Float32Array;
  /** Min/max pyramid of rendered-height-before-exaggeration (max(h, 0)); level k has n/2^k cells per side. */
  readonly minPyr: Float32Array[] = [];
  readonly maxPyr: Float32Array[] = [];
  exaggeration = 1;

  constructor(layer: Layer) {
    this.n = layer.w;
    this.size = layer.worldKm * 1000;
    this.cell = this.size / this.n;
    this.data = layer.data instanceof Float32Array ? layer.data : Float32Array.from(layer.data);
    let lo = Float32Array.from(this.data, (v) => Math.max(0, v));
    let hi = lo.slice();
    this.minPyr.push(lo);
    this.maxPyr.push(hi);
    for (let s = this.n; s > 1; s >>= 1) {
      const h = s >> 1;
      const nlo = new Float32Array(h * h);
      const nhi = new Float32Array(h * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < h; x++) {
          const a = 2 * y * s + 2 * x;
          nlo[y * h + x] = Math.min(lo[a], lo[a + 1], lo[a + s], lo[a + s + 1]);
          nhi[y * h + x] = Math.max(hi[a], hi[a + 1], hi[a + s], hi[a + s + 1]);
        }
      }
      this.minPyr.push(nlo);
      this.maxPyr.push(nhi);
      lo = nlo;
      hi = nhi;
    }
  }

  /** Raw elevation (m, may be negative) at world (x, y), bilinear. */
  elevationAt(x: number, y: number): number {
    const fx = Math.min(this.n - 1, Math.max(0, x / this.cell - 0.5));
    const fy = Math.min(this.n - 1, Math.max(0, (this.size - y) / this.cell - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(this.n - 1, x0 + 1);
    const y1 = Math.min(this.n - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const d = this.data;
    const n = this.n;
    const a = d[y0 * n + x0] + (d[y0 * n + x1] - d[y0 * n + x0]) * tx;
    const b = d[y1 * n + x0] + (d[y1 * n + x1] - d[y1 * n + x0]) * tx;
    return a + (b - a) * ty;
  }

  heightAt(x: number, y: number): number {
    return Math.max(0, this.elevationAt(x, y)) * this.exaggeration;
  }

  /**
   * Min/max rendered height (exaggerated) over the world rectangle [x0, x0+w] × [y0, y0+w],
   * conservatively from the pyramid level whose cells are about as large as the rectangle.
   */
  rangeOver(x0: number, y0: number, w: number): [number, number] {
    const level = Math.max(0, Math.min(this.minPyr.length - 1, Math.floor(Math.log2(Math.max(1, w / this.cell)))));
    const s = this.n >> level;
    const cs = this.size / s;
    const cx0 = Math.max(0, Math.floor(x0 / cs));
    const cx1 = Math.min(s - 1, Math.floor((x0 + w) / cs));
    // Rows run north → south.
    const cy0 = Math.max(0, Math.floor((this.size - (y0 + w)) / cs));
    const cy1 = Math.min(s - 1, Math.floor((this.size - y0) / cs));
    let lo = Infinity;
    let hi = -Infinity;
    const minL = this.minPyr[level];
    const maxL = this.maxPyr[level];
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        lo = Math.min(lo, minL[y * s + x]);
        hi = Math.max(hi, maxL[y * s + x]);
      }
    }
    return [lo * this.exaggeration, hi * this.exaggeration];
  }

  get maxHeight(): number {
    return this.maxPyr[this.maxPyr.length - 1][0] * this.exaggeration;
  }

  /** Ray march over the rendered surface inside the world slab, refined by bisection. */
  raycast(o: Vec3, d: Vec3): Vec3 | null {
    const top = this.maxHeight + 1;
    // Clip the ray to the box [0, size]² × [0, top].
    let t0 = 0;
    let t1 = Infinity;
    const clip = (p: number, dp: number, lo: number, hi: number): boolean => {
      if (Math.abs(dp) < 1e-12) return p >= lo && p <= hi;
      let a = (lo - p) / dp;
      let b = (hi - p) / dp;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      return t0 <= t1;
    };
    if (!clip(o.x, d.x, 0, this.size) || !clip(o.y, d.y, 0, this.size) || !clip(o.z, d.z, -1, top)) return null;
    const len = Math.hypot(d.x, d.y, d.z);
    const step = (0.5 * this.cell) / Math.max(1e-9, Math.hypot(d.x, d.y) / len) / len;
    const above = (t: number): number => o.z + d.z * t - this.heightAt(o.x + d.x * t, o.y + d.y * t);
    let prev = t0;
    if (above(prev) <= 0) return at(o, d, prev);
    const dt = Math.min(step, (t1 - t0) / 2);
    for (let t = t0 + dt; t <= t1 + dt; t += dt) {
      const tc = Math.min(t, t1);
      if (above(tc) <= 0) {
        let lo = prev;
        let hi = tc;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        return at(o, d, hi);
      }
      prev = tc;
      if (tc === t1) break;
    }
    return null;
  }
}

function at(o: Vec3, d: Vec3, t: number): Vec3 {
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}
