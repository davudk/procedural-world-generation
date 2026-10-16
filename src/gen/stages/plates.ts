import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import { MinHeap } from '../grid/heap';
import type { StageDef } from '../pipeline';

export interface PlatesExtra {
  n: number;
  /** Plate id per cell, n × n. */
  plate: Int32Array;
  /** 1 if the plate carries continental crust. */
  continental: Uint8Array;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/**
 * S1 Plates — M0 placeholder (M1 adds motion, boundary classes and distance fields).
 * Plates grow from spaced seeds by a noise-weighted multi-source Dijkstra, so boundaries are irregular
 * instead of straight Voronoi edges (research 01 §1.1). Larger weights grow faster, which gives the
 * plate-size skew; microplates get small weights.
 */
export const platesStage: StageDef = {
  id: 'plates',
  label: 'Plates',
  inputs: [],
  reads: ['worldSize', 'plateCount', 'microplateCount', 'plateSizeSkew', 'boundaryWarp', 'continentalShare'],
  async run(ctx) {
    const n = ctx.mode === 'preview' ? 128 : 256;
    const major = ctx.drawn('plateCount');
    const micro = ctx.drawn('microplateCount');
    const count = major + micro;
    const rng = ctx.rng('seeds');

    // Best-candidate sampling: well-spaced seeds without a regular pattern.
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let best = -1;
      for (let k = 0; k < 12; k++) {
        const x = rng.range(0.04, 0.96);
        const y = rng.range(0.04, 0.96);
        let dmin = Infinity;
        for (let j = 0; j < i; j++) dmin = Math.min(dmin, (x - sx[j]) ** 2 + (y - sy[j]) ** 2);
        if (dmin > best) {
          best = dmin;
          sx[i] = x;
          sy[i] = y;
        }
      }
    }

    const skew = ctx.num('plateSizeSkew');
    const weight = new Float64Array(count);
    for (let i = 0; i < count; i++) weight[i] = i < major ? Math.exp(skew * 0.9 * gaussian(rng)) : 0.3;

    const warp = ctx.num('boundaryWarp');
    const noise = new Noise2(ctx.rng('noise').nextU32());
    const freq = 6 / n; // ~6 noise periods across the world
    const cost = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) cost[y * n + x] = 1 + warp * 4 * (0.5 + 0.5 * noise.fbm(x * freq, y * freq, 4));
    }

    const plate = new Int32Array(n * n).fill(-1);
    const dist = new Float64Array(n * n).fill(Infinity);
    const heap = new MinHeap(n * 4);
    for (let i = 0; i < count; i++) {
      const c = Math.floor(sy[i] * n) * n + Math.floor(sx[i] * n);
      if (dist[c] === 0) continue;
      dist[c] = 0;
      plate[c] = i;
      heap.push(0, c);
    }
    let popped = 0;
    while (heap.size > 0) {
      const d = heap.peekKey();
      const c = heap.pop();
      if (d > dist[c]) continue;
      const p = plate[c];
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nc = ny * n + nx;
        const nd = d + (DL[k] * 0.5 * (cost[c] + cost[nc])) / weight[p];
        if (nd < dist[nc]) {
          dist[nc] = nd;
          plate[nc] = p;
          heap.push(nd, nc);
        }
      }
      if ((++popped & 0xffff) === 0) await ctx.checkpoint();
    }

    // Continental crust: random plate order until the target share of the world is covered.
    const area = new Float64Array(count);
    for (let c = 0; c < n * n; c++) area[plate[c]]++;
    const order = Array.from({ length: count }, (_, i) => i);
    const orng = ctx.rng('crust');
    for (let i = count - 1; i > 0; i--) {
      const j = orng.int(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const continental = new Uint8Array(count);
    const target = ctx.num('continentalShare') * n * n;
    let covered = 0;
    for (const i of order) {
      if (covered >= target) break;
      continental[i] = 1;
      covered += area[i];
    }
    const crust = new Uint8Array(n * n);
    for (let c = 0; c < n * n; c++) crust[c] = continental[plate[c]];

    const worldKm = ctx.num('worldSize');
    const layers: Layer[] = [
      { id: 'plates', label: 'Plates', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, unit: '', min: 0, max: count - 1, data: plate },
      { id: 'crust', label: 'Crust type', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, unit: '', min: 0, max: 1, data: crust },
    ];
    const extra: PlatesExtra = { n, plate, continental };
    return {
      layers,
      stats: { plates: major, microplates: micro, continentalPlates: continental.reduce((a, b) => a + b, 0) },
      outcomes: {},
      extra,
    };
  },
};

function gaussian(rng: { float(): number }): number {
  const u = Math.max(1e-12, rng.float());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.float());
}
