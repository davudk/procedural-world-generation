import { faceDir } from '../../shared/cube';
import type { Vec3 } from '../camera/ground';
import type { GlobeHeightField } from '../globe/globeGround';
import { GRID, type LodSettings } from './cdlod';

/**
 * Floats per sphere instance: face, centre angles a and b (rad), size (rad), the node centre at sea
 * level relative to the eye (m, computed in float64), level, morph start, morph end (m).
 */
export const SPHERE_INSTANCE_FLOATS = 10;
export const SPHERE_MAX_NODES = 2048;

const Q = Math.PI / 4;

/** A selected node (kept for tests and debugging; the GPU reads `instances`). */
export interface SphereNode {
  face: number;
  a0: number;
  b0: number;
  size: number;
  level: number;
}

/**
 * CDLOD on the cube-sphere (research 10 §6.1): six quadtrees in face angles (a, b), one root per face.
 * Each node's bounds are the 3×3 lattice of its directions at R + h_min and, lifted past the arcs'
 * bulge, at R + h_max; their convex hull holds the patch. Selection is Strugar's range test on the
 * eye's distance to the hull's box, as on flat maps, so neighbouring levels differ by at most one also
 * across face seams (the equal-angle subdivision of both faces meets the shared edge at the same
 * points). Nodes outside the frustum or entirely below the horizon of the sea-level sphere are skipped.
 */
export class SphereCdlodSelector {
  readonly instances = new Float32Array(SPHERE_MAX_NODES * SPHERE_INSTANCE_FLOATS);
  readonly nodes: SphereNode[] = [];
  /** Nodes skipped by the horizon test (only recorded with `keepNodes`). */
  readonly culled: SphereNode[] = [];
  count = 0;
  /** Nodes skipped by the horizon test in the last selection. */
  horizonCulled = 0;
  /** Record selected nodes in `nodes` (tests). */
  keepNodes = false;
  private ranges: number[] = [];
  private readonly pts = new Float64Array(18 * 3);
  private readonly d = new Float64Array(3);

  get levelRanges(): readonly number[] {
    return this.ranges;
  }

  /** Quadtree depth for a face grid: leaf vertices every 1/8 cell. */
  static depthFor(n: number): number {
    return Math.max(1, Math.round(Math.log2(n / 4)));
  }

  select(hf: GlobeHeightField, eye: Vec3, planes: Float64Array, s: LodSettings): number {
    const R = hf.radius;
    const faceM = (Math.PI / 2) * R;
    const leafSpacing = faceM / 2 ** s.maxDepth / GRID;
    const r0 = (leafSpacing * s.pxPerRad) / s.vertexPx;
    this.ranges = [];
    for (let l = 0; l <= s.maxDepth; l++) this.ranges.push(Math.max(r0 * 2 ** l, (faceM / 2 ** (s.maxDepth - l)) * 1.6));
    this.count = 0;
    this.horizonCulled = 0;
    this.nodes.length = 0;
    this.culled.length = 0;
    for (let f = 0; f < 6; f++) this.visit(hf, f, -Q, -Q, Math.PI / 2, s.maxDepth, eye, planes, s.boundsPad);
    return this.count;
  }

  private visit(
    hf: GlobeHeightField, face: number, a0: number, b0: number, size: number, level: number,
    eye: Vec3, planes: Float64Array, pad: number,
  ): void {
    const R = hf.radius;
    const [zlo, zhi] = hf.rangeOver(face, a0, b0, size);
    const lo = R + Math.max(0, zlo - pad);
    const hi = (R + zhi + pad) / Math.cos(Math.min(size, 1.5) / 2);
    const p = this.pts;
    let k = 0;
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        faceDir(face, a0 + (i * size) / 2, b0 + (j * size) / 2, this.d);
        for (const r of [lo, hi]) {
          p[k++] = this.d[0] * r;
          p[k++] = this.d[1] * r;
          p[k++] = this.d[2] * r;
        }
      }
    }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < 54; i += 3) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
      z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    if (!boxInFrustum(planes, x0 - eye.x, y0 - eye.y, z0 - eye.z, x1 - eye.x, y1 - eye.y, z1 - eye.z)) return;
    if (hullBelowHorizon(p, 18, eye, R * (1 - 1e-7))) {
      this.horizonCulled++;
      if (this.keepNodes) this.culled.push({ face, a0, b0, size, level });
      return;
    }
    if (level === 0 || !sphereHitsAabb(eye, this.ranges[level - 1], x0, y0, z0, x1, y1, z1)) {
      this.emit(hf, face, a0, b0, size, level, eye);
      return;
    }
    const h = size / 2;
    this.visit(hf, face, a0, b0, h, level - 1, eye, planes, pad);
    this.visit(hf, face, a0 + h, b0, h, level - 1, eye, planes, pad);
    this.visit(hf, face, a0, b0 + h, h, level - 1, eye, planes, pad);
    this.visit(hf, face, a0 + h, b0 + h, h, level - 1, eye, planes, pad);
  }

  private emit(hf: GlobeHeightField, face: number, a0: number, b0: number, size: number, level: number, eye: Vec3): void {
    if (this.count >= SPHERE_MAX_NODES) return;
    const end = this.ranges[level];
    const ac = a0 + size / 2;
    const bc = b0 + size / 2;
    faceDir(face, ac, bc, this.d);
    const R = hf.radius;
    const o = this.count++ * SPHERE_INSTANCE_FLOATS;
    const a = this.instances;
    a[o] = face;
    a[o + 1] = ac;
    a[o + 2] = bc;
    a[o + 3] = size;
    // Float64 here; the shader adds well-conditioned offsets from this centre (no large cancellations).
    a[o + 4] = this.d[0] * R - eye.x;
    a[o + 5] = this.d[1] * R - eye.y;
    a[o + 6] = this.d[2] * R - eye.z;
    a[o + 7] = level;
    a[o + 8] = end * 0.7;
    a[o + 9] = end;
    if (this.keepNodes) this.nodes.push({ face, a0, b0, size, level });
  }
}

/**
 * True when every one of the `n` points is hidden from the eye by the ball |x| ≤ r: the segment from
 * the eye to the point meets the ball before the point. The hidden set is convex (the tangent cone
 * behind the ball's near cap), so a hull whose corners are all hidden is hidden as a whole.
 */
export function hullBelowHorizon(p: Float64Array, n: number, eye: Vec3, r: number): boolean {
  const e2 = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z;
  const c = e2 - r * r;
  if (c <= 0) return false;
  for (let i = 0; i < n; i++) {
    const vx = p[i * 3] - eye.x, vy = p[i * 3 + 1] - eye.y, vz = p[i * 3 + 2] - eye.z;
    // |E + t·v|² = r²  →  a t² + 2 b t + c = 0; hidden when the first root lies in (0, 1).
    const a = vx * vx + vy * vy + vz * vz;
    const b = eye.x * vx + eye.y * vy + eye.z * vz;
    const disc = b * b - a * c;
    if (b >= 0 || disc < 0) return false;
    const t = (-b - Math.sqrt(disc)) / a;
    if (!(t < 1)) return false;
  }
  return true;
}

function sphereHitsAabb(c: Vec3, r: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  const dx = Math.max(x0 - c.x, 0, c.x - x1);
  const dy = Math.max(y0 - c.y, 0, c.y - y1);
  const dz = Math.max(z0 - c.z, 0, c.z - z1);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** Planes are (a, b, c, d) with inside where a·x + b·y + c·z + d ≥ 0. */
export function boxInFrustum(p: Float64Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let i = 0; i < 6; i++) {
    const a = p[i * 4];
    const b = p[i * 4 + 1];
    const c = p[i * 4 + 2];
    const d = p[i * 4 + 3];
    if (!Number.isFinite(d)) continue;
    const px = a >= 0 ? x1 : x0;
    const py = b >= 0 ? y1 : y0;
    const pz = c >= 0 ? z1 : z0;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}
