import { dirSurface } from '../../shared/cube';
import type { RiverGraph } from '../../shared/protocol';

/**
 * Growable struct-of-arrays river graph (finalised into the protocol's typed arrays). On flat maps
 * positions are map metres (x, y). On the sphere they are 3D points (x, y, w) in metres from the
 * planet centre (on or near the sphere of radius `radiusM`), so distances and smoothing need no
 * face bookkeeping; `finish` turns them into the protocol's (face, u, v).
 */
export class GraphBuilder {
  readonly x: number[] = [];
  readonly y: number[] = [];
  /** Sphere only: third coordinate. */
  readonly w: number[] = [];
  readonly zWater: number[] = [];
  readonly zBed: number[] = [];
  readonly q: number[] = [];
  readonly area: number[] = [];
  readonly width: number[] = [];
  readonly depth: number[] = [];
  readonly strahler: number[] = [];
  readonly down: number[] = [];
  readonly flags: number[] = [];
  readonly reachStart: number[] = [];
  readonly reachLen: number[] = [];
  readonly reachDown: number[] = [];

  /** Planet radius (m) on the sphere; Infinity on flat maps. */
  constructor(readonly radiusM = Infinity) {}

  get sphere(): boolean {
    return Number.isFinite(this.radiusM);
  }

  /** Distance between nodes i and j (m; chord on the sphere, which is the arc to < 1e-5 at river spacings). */
  dist(i: number, j: number): number {
    return this.sphere
      ? Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i], this.w[j] - this.w[i])
      : Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i]);
  }

  get size(): number {
    return this.x.length;
  }

  get reaches(): number {
    return this.reachStart.length;
  }

  beginReach(): number {
    this.reachStart.push(this.x.length);
    this.reachLen.push(0);
    this.reachDown.push(-1);
    return this.reachStart.length - 1;
  }

  /** Appends a node to the current reach, linked to the previous node of that reach. */
  node(
    x: number, y: number, zWater: number, zBed: number, q: number, area: number, width: number, depth: number, strahler: number, flags: number,
    w = 0,
  ): number {
    const r = this.reachStart.length - 1;
    const i = this.x.length;
    if (this.reachLen[r] > 0) this.down[i - 1] = i;
    if (this.sphere) {
      // Back onto the sphere (smoothing and offsets move points off it by up to a few metres).
      const k = this.radiusM / Math.hypot(x, y, w);
      x *= k;
      y *= k;
      w *= k;
      this.w.push(w);
    }
    this.x.push(x);
    this.y.push(y);
    this.zWater.push(zWater);
    this.zBed.push(zBed);
    this.q.push(q);
    this.area.push(area);
    this.width.push(width);
    this.depth.push(depth);
    this.strahler.push(strahler);
    this.down.push(-1);
    this.flags.push(flags);
    this.reachLen[r]++;
    return i;
  }

  /** Last node of reach r. */
  last(r: number): number {
    return this.reachStart[r] + this.reachLen[r] - 1;
  }

  finish(): RiverGraph {
    const nr = this.reachStart.length;
    const reachMinArea = new Float32Array(nr);
    for (let r = 0; r < nr; r++) {
      let m = Infinity;
      for (let i = this.reachStart[r]; i < this.reachStart[r] + this.reachLen[r]; i++) m = Math.min(m, this.area[i]);
      reachMinArea[r] = Number.isFinite(m) ? m : 0;
    }
    let x = Float32Array.from(this.x);
    let y = Float32Array.from(this.y);
    let face: Uint8Array | undefined;
    if (this.sphere) {
      const N = this.x.length;
      face = new Uint8Array(N);
      x = new Float32Array(N);
      y = new Float32Array(N);
      const s = new Float64Array(3);
      for (let i = 0; i < N; i++) {
        dirSurface(this.x[i], this.y[i], this.w[i], this.radiusM, s);
        face[i] = s[0];
        x[i] = s[1];
        y[i] = s[2];
      }
    }
    const out: RiverGraph = {
      n: this.x.length,
      x,
      y,
      zWater: Float32Array.from(this.zWater),
      zBed: Float32Array.from(this.zBed),
      q: Float32Array.from(this.q),
      area: Float32Array.from(this.area),
      width: Float32Array.from(this.width),
      depth: Float32Array.from(this.depth),
      strahler: Uint8Array.from(this.strahler),
      down: Int32Array.from(this.down),
      flags: Uint16Array.from(this.flags),
      reachStart: Uint32Array.from(this.reachStart),
      reachLen: Uint32Array.from(this.reachLen),
      reachDown: Int32Array.from(this.reachDown),
      reachMinArea,
    };
    if (face) out.face = face;
    return out;
  }
}
