import type { Layer } from '../../shared/protocol';
import type { Vec3 } from '../camera/ground';
import { dirToFaceAngles, PAD, padFaces } from './cubeTex';

/**
 * Planet-centred world space for spheres (Sphere phase 3): metres, origin at the planet centre, +z
 * toward the north pole, longitude 0 along +x (shared/cube.ts). Rendered radius = R + surface × exaggeration.
 */
export interface GlobeGround {
  /** Sea-level radius R (m). */
  readonly radius: number;
  /** Highest rendered height above R (m, exaggerated). */
  readonly maxHeight: number;
  /** Rendered height above R (m, exaggerated; the sea is at 0) toward a direction (any length). */
  heightAtDir(x: number, y: number, z: number): number;
  /** First intersection of the ray o + t·d (t ≥ 0, d unit) with the rendered surface, or null. */
  raycast(o: Vec3, d: Vec3): Vec3 | null;
}

/** Entry and exit distances of the ray o + t·d (d unit) through the sphere |p| = r, or null. */
export function raySphere(o: Vec3, d: Vec3, r: number): [number, number] | null {
  const b = o.x * d.x + o.y * d.y + o.z * d.z;
  const c = o.x * o.x + o.y * o.y + o.z * o.z - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  // Numerically stable roots.
  const q = b > 0 ? -b - s : -b + s;
  let t0 = q;
  let t1 = q === 0 ? 0 : c / q;
  if (t0 > t1) [t0, t1] = [t1, t0];
  return [t0, t1];
}

/** A smooth sphere at sea level: the placeholder until the first sphere elevation arrives, and for tests. */
export class SphereGround implements GlobeGround {
  constructor(readonly radius: number, readonly level = 0) {}
  get maxHeight(): number {
    return this.level;
  }
  heightAtDir(): number {
    return this.level;
  }
  raycast(o: Vec3, d: Vec3): Vec3 | null {
    const h = raySphere(o, d, this.radius + this.level);
    if (!h || h[1] < 0) return null;
    const t = h[0] >= 0 ? h[0] : h[1];
    return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  }
}

/**
 * CPU copy of a cube-sphere elevation for picking, culling and camera clamps: six faces padded like
 * the GPU textures (so CPU and GPU bilinear agree across seams) and per-face min/max pyramids of the
 * rendered surface max(h, 0) (the sea is the water lid at 0; spheres have no lakes yet).
 */
export class GlobeHeightField implements GlobeGround {
  readonly radius: number;
  readonly n: number;
  /** Angular cell size Δ = (π/2)/n and the nominal cell (m). */
  readonly delta: number;
  readonly cellM: number;
  /** Raw elevation, face-major (m). */
  readonly data: Float32Array;
  /** Padded rendered surface, 6 × (n + 2·PAD)² (m, before exaggeration). */
  readonly padded: Float32Array;
  readonly m: number;
  /** Per face, levels 0 (n²) … log2(n) (1²) of min / max surface. */
  readonly minPyr: Float32Array[][] = [];
  readonly maxPyr: Float32Array[][] = [];
  exaggeration = 1;
  private readonly fa = new Float64Array(3);

  constructor(layer: Layer) {
    const n = layer.w;
    this.n = n;
    this.radius = (layer.radiusKm ?? (layer.worldKm * 4) / (2 * Math.PI)) * 1000;
    this.delta = Math.PI / 2 / n;
    this.cellM = this.delta * this.radius;
    this.data = layer.data instanceof Float32Array ? layer.data : Float32Array.from(layer.data);
    this.m = n + 2 * PAD;
    // Pad the raw elevation, then lid it, as the shader does per fetched texel (the corner texels are
    // means of raw cells, so lidding first would differ there).
    this.padded = padFaces(this.data, n);
    for (let i = 0; i < this.padded.length; i++) this.padded[i] = Math.max(0, this.padded[i]);
    const m = this.m;
    for (let f = 0; f < 6; f++) {
      // Level 0 spans each cell's 3×3 neighbourhood (across seams through the padding): a bilinear
      // sample anywhere in a cell reads only those texels, so the pyramid bounds the rendered surface.
      let lo = new Float32Array(n * n);
      let hi = new Float32Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let a = Infinity, b = -Infinity;
          for (let dy = 0; dy < 3; dy++) {
            const row = f * m * m + (y + PAD - 1 + dy) * m + x + PAD - 1;
            for (let dx = 0; dx < 3; dx++) {
              const v = this.padded[row + dx];
              a = Math.min(a, v);
              b = Math.max(b, v);
            }
          }
          lo[y * n + x] = a;
          hi[y * n + x] = b;
        }
      }
      const mins = [lo];
      const maxs = [hi];
      for (let s = n; s > 1; s >>= 1) {
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
        mins.push(nlo);
        maxs.push(nhi);
        lo = nlo;
        hi = nhi;
      }
      this.minPyr.push(mins);
      this.maxPyr.push(maxs);
    }
  }

  get maxHeight(): number {
    let hi = 0;
    for (let f = 0; f < 6; f++) hi = Math.max(hi, this.maxPyr[f][this.maxPyr[f].length - 1][0]);
    return hi * this.exaggeration;
  }

  /** Surface (m, before exaggeration) at face angles (a, b): the GPU's bilinear over padded texels. */
  surfaceAt(face: number, a: number, b: number): number {
    const m = this.m;
    const px = Math.min(m - 1.001, Math.max(0, (a + Math.PI / 4) / this.delta - 0.5 + PAD));
    const py = Math.min(m - 1.001, Math.max(0, (b + Math.PI / 4) / this.delta - 0.5 + PAD));
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const tx = px - x0;
    const ty = py - y0;
    const d = this.padded;
    const o = face * m * m + y0 * m + x0;
    const top = d[o] + (d[o + 1] - d[o]) * tx;
    const bot = d[o + m] + (d[o + m + 1] - d[o + m]) * tx;
    return top + (bot - top) * ty;
  }

  /** Raw elevation (m, may be negative) toward a direction, nearest cell. */
  elevationAtDir(x: number, y: number, z: number): number {
    dirToFaceAngles(x, y, z, this.fa);
    const n = this.n;
    const cx = Math.min(n - 1, Math.max(0, Math.floor((this.fa[1] + Math.PI / 4) / this.delta)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor((this.fa[2] + Math.PI / 4) / this.delta)));
    return this.data[(this.fa[0] * n + cy) * n + cx];
  }

  heightAtDir(x: number, y: number, z: number): number {
    dirToFaceAngles(x, y, z, this.fa);
    return this.surfaceAt(this.fa[0], this.fa[1], this.fa[2]) * this.exaggeration;
  }

  /**
   * Min/max rendered height (exaggerated) over the face-angle square [a0, a0 + s] × [b0, b0 + s],
   * conservatively from the pyramid level whose cells are about as large as the square.
   */
  rangeOver(face: number, a0: number, b0: number, s: number): [number, number] {
    const n = this.n;
    const pyr = this.minPyr[face];
    const level = Math.max(0, Math.min(pyr.length - 1, Math.floor(Math.log2(Math.max(1, s / this.delta)))));
    const k = n >> level;
    const cs = (Math.PI / 2) / k;
    const Q = Math.PI / 4;
    const x0 = Math.max(0, Math.floor((a0 + Q) / cs));
    const x1 = Math.min(k - 1, Math.floor((a0 + s + Q) / cs));
    const y0 = Math.max(0, Math.floor((b0 + Q) / cs));
    const y1 = Math.min(k - 1, Math.floor((b0 + s + Q) / cs));
    const mins = pyr[level];
    const maxs = this.maxPyr[face][level];
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        lo = Math.min(lo, mins[y * k + x]);
        hi = Math.max(hi, maxs[y * k + x]);
      }
    }
    return [lo * this.exaggeration, hi * this.exaggeration];
  }

  /** Ray march through the shell between R and R + maxHeight, refined by bisection. */
  raycast(o: Vec3, d: Vec3): Vec3 | null {
    const R = this.radius;
    const outer = raySphere(o, d, R + this.maxHeight + 1);
    if (!outer || outer[1] < 0) return null;
    const t0 = Math.max(0, outer[0]);
    let t1 = outer[1];
    // Nothing is below the sea surface: the inner sphere stops the march.
    const inner = raySphere(o, d, R);
    if (inner && inner[0] >= 0) t1 = Math.min(t1, inner[0]);
    const above = (t: number): number => {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      return Math.sqrt(x * x + y * y + z * z) - R - this.heightAtDir(x, y, z);
    };
    let prev = t0;
    if (above(prev) <= 0) return at(o, d, prev);
    const dt = Math.min(0.5 * this.cellM, Math.max(1e-6, (t1 - t0) / 2));
    for (let t = t0 + dt; t <= t1 + dt; t += dt) {
      const tc = Math.min(t, t1);
      if (above(tc) <= 0) {
        let lo = prev;
        let hi = tc;
        for (let k = 0; k < 30; k++) {
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
