import type { Vec3 } from '../camera/ground';
import type { HeightField } from '../heightField';

/** Quads per node side; every node is drawn with the same (GRID+1)² vertex mesh. */
export const GRID = 32;
/** Floats per instance: rel x, rel y (m, camera-relative), size (m), level, morph start, morph end. */
export const INSTANCE_FLOATS = 6;
export const MAX_NODES = 2048;

export interface LodSettings {
  /** Depth of the finest level below the root. */
  maxDepth: number;
  /** Target on-screen spacing of grid vertices, px. */
  vertexPx: number;
  /** Pixels per radian at the screen centre: viewH / (2·tan(fovY/2)). */
  pxPerRad: number;
  /** Extra padding (m) added to node bounds: amplitude of shader-side detail. */
  boundsPad: number;
}

/**
 * CDLOD node selection (Strugar 2009; research 04 §1.2). Level 0 is the finest. A node is drawn
 * whole when the eye is outside the range sphere of the next finer level; otherwise its four
 * children are visited. Vertices morph toward the coarser grid near the end of their level's range,
 * so neighbouring levels meet without cracks.
 */
export class CdlodSelector {
  readonly instances = new Float32Array(MAX_NODES * INSTANCE_FLOATS);
  count = 0;
  private ranges: number[] = [];

  /** Morph range per level (m). */
  get levelRanges(): readonly number[] {
    return this.ranges;
  }

  select(hf: HeightField, eye: Vec3, origin: Vec3, planes: Float64Array, s: LodSettings): number {
    const leafSpacing = hf.size / 2 ** s.maxDepth / GRID;
    const r0 = (leafSpacing * s.pxPerRad) / s.vertexPx;
    this.ranges = [];
    for (let l = 0; l <= s.maxDepth; l++) this.ranges.push(Math.max(r0 * 2 ** l, (hf.size / 2 ** (s.maxDepth - l)) * 1.6));
    this.count = 0;
    this.visit(hf, 0, 0, hf.size, s.maxDepth, eye, origin, planes, s.boundsPad);
    return this.count;
  }

  private visit(
    hf: HeightField, x: number, y: number, size: number, level: number,
    eye: Vec3, origin: Vec3, planes: Float64Array, pad: number,
  ): void {
    const [zlo, zhi] = hf.rangeOver(x, y, size);
    const lo = zlo - pad;
    const hi = zhi + pad;
    if (!boxInFrustum(planes, x - origin.x, y - origin.y, lo - origin.z, x + size - origin.x, y + size - origin.y, hi - origin.z)) return;
    if (level === 0 || !sphereHitsBox(eye, this.ranges[level - 1], x, y, lo, size, hi)) {
      this.emit(x, y, size, level, origin);
      return;
    }
    const h = size / 2;
    this.visit(hf, x, y, h, level - 1, eye, origin, planes, pad);
    this.visit(hf, x + h, y, h, level - 1, eye, origin, planes, pad);
    this.visit(hf, x, y + h, h, level - 1, eye, origin, planes, pad);
    this.visit(hf, x + h, y + h, h, level - 1, eye, origin, planes, pad);
  }

  private emit(x: number, y: number, size: number, level: number, origin: Vec3): void {
    if (this.count >= MAX_NODES) return;
    const end = this.ranges[level];
    const o = this.count++ * INSTANCE_FLOATS;
    const a = this.instances;
    a[o] = x - origin.x;
    a[o + 1] = y - origin.y;
    a[o + 2] = size;
    a[o + 3] = level;
    a[o + 4] = end * 0.7;
    a[o + 5] = end;
  }
}

function sphereHitsBox(c: Vec3, r: number, x: number, y: number, zlo: number, size: number, zhi: number): boolean {
  const dx = Math.max(x - c.x, 0, c.x - (x + size));
  const dy = Math.max(y - c.y, 0, c.y - (y + size));
  const dz = Math.max(zlo - c.z, 0, c.z - zhi);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** Planes are (a, b, c, d) with inside where a·x + b·y + c·z + d ≥ 0. */
function boxInFrustum(p: Float64Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
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
