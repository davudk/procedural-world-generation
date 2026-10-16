import { beforeAll, describe, expect, it } from 'vitest';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { CreekManager } from '../src/render/water/creeks/creekManager';
import { generateCreeks, prepareCreeks, type CreekInput } from '../src/render/water/creeks/creekGen';
import { resolve } from '../src/shared/config/resolve';
import { hashBytes } from '../src/shared/hash';
import { RIVER, type Layer, type RiverGraph } from '../src/shared/protocol';

type HeightAt = CreekInput['heightAt'];

/** A test area: a square block of macro cells, its inner part (2-cell margin removed) and the terrain to walk on. */
interface Block {
  cells: number[];
  inner: Set<number>;
  heightAt: HeightAt;
}

/** A real world on 1 km macro cells (512 km, 512² build grid). */
interface World {
  input: Omit<CreekInput, 'heightAt'>;
  inland: Block;
  coast: Block;
}

let W: World;
const SIDE = 40;

function bilinear(z: Float32Array, n: number, cellM: number): HeightAt {
  return (x, y) => {
    const fx = Math.min(n - 1, Math.max(0, x / cellM - 0.5));
    const fy = Math.min(n - 1, Math.max(0, y / cellM - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = z[y0 * n + x0] + (z[y0 * n + x1] - z[y0 * n + x0]) * tx;
    const b = z[y1 * n + x0] + (z[y1 * n + x1] - z[y1 * n + x0]) * tx;
    return a + (b - a) * ty;
  };
}

/** Bilinear macro plus a few metres of smooth detail, standing in for the renderer's detail octaves. */
function withDetail(base: HeightAt): HeightAt {
  return (x, y) => base(x, y) + 2 * Math.sin(x / 97 + 1.3) * Math.cos(y / 83 - 0.4) + Math.sin((x + 0.7 * y) / 41);
}

async function buildWorld(seed: number): Promise<World> {
  const p = new Pipeline(STAGES);
  let error = '';
  await p.run(resolve({ seed, archetype: 'earth', pins: { worldSize: 512, lemGrid: '256', macroGrid: '512' } }), 'build', 1, (m) => {
    if (m.type === 'error') error = m.message;
  }, () => false);
  if (error) throw new Error(error);
  const hydro = p.output('hydro')!;
  const layer = (id: string): Layer => hydro.layers.find((l) => l.id === id)!;
  const elev = layer('elevation');
  const n = elev.w;
  const cellM = (elev.worldKm * 1000) / n;
  const input = {
    n, cellM, seed,
    elevation: elev.data as Float32Array,
    waterClass: layer('waterClass').data as Uint8Array,
    dischargeLog: layer('discharge').data as Float32Array,
    rivers: hydro.vectors!.rivers!,
  };
  // Score every 40×40 window (step 8) by land share and macro river nodes.
  const wc = input.waterClass;
  const g = input.rivers;
  const windows: { x: number; y: number; land: number; sea: number; riv: number }[] = [];
  for (let y = 0; y + SIDE <= n; y += 8) {
    for (let x = 0; x + SIDE <= n; x += 8) {
      let land = 0;
      let sea = 0;
      for (let j = y; j < y + SIDE; j++) {
        for (let i = x; i < x + SIDE; i++) {
          const w = wc[j * n + i];
          if (w === 1) sea++;
          else if (w !== 2 && w !== 3 && w !== 6) land++;
        }
      }
      let riv = 0;
      for (let k = 0; k < g.n; k += 7) {
        const i = Math.floor(g.x[k] / cellM);
        const j = Math.floor(g.y[k] / cellM);
        if (i >= x && i < x + SIDE && j >= y && j < y + SIDE) riv++;
      }
      windows.push({ x, y, land: land / (SIDE * SIDE), sea: sea / (SIDE * SIDE), riv });
    }
  }
  const pick = (score: (w: (typeof windows)[number]) => number): { x: number; y: number } =>
    windows.reduce((a, b) => (score(b) > score(a) ? b : a));
  const block = (at: { x: number; y: number }, heightAt: HeightAt): Block => {
    const cells: number[] = [];
    const inner = new Set<number>();
    for (let j = at.y; j < at.y + SIDE; j++) {
      for (let i = at.x; i < at.x + SIDE; i++) {
        cells.push(j * n + i);
        if (j >= at.y + 2 && j < at.y + SIDE - 2 && i >= at.x + 2 && i < at.x + SIDE - 2) inner.add(j * n + i);
      }
    }
    return { cells, inner, heightAt };
  };
  const base = bilinear(input.elevation, n, cellM);
  return {
    input,
    inland: block(pick((w) => w.land * 1600 + Math.min(w.riv, 200)), base),
    coast: block(pick((w) => (w.sea > 0.25 && w.sea < 0.6 ? 1000 : 0) + Math.min(w.riv, 300)), withDetail(base)),
  };
}

function cellHash(g: RiverGraph): number[] {
  return [g.n, hashBytes(g.x), hashBytes(g.y), hashBytes(g.zWater), hashBytes(g.area), hashBytes(g.width), hashBytes(g.flags), hashBytes(g.down), hashBytes(g.reachStart), hashBytes(g.reachDown)];
}

/** Segment grid over a graph's segments (node i → down[i]), for crossing and on-channel tests. */
class Segs {
  readonly bins = new Map<number, number[]>();
  constructor(readonly g: RiverGraph, readonly bin: number) {
    for (let i = 0; i < g.n; i++) {
      const d = g.down[i];
      if (d < 0) continue;
      for (const k of this.keys(g.x[i], g.y[i], g.x[d], g.y[d])) {
        let a = this.bins.get(k);
        if (!a) this.bins.set(k, (a = []));
        a.push(i);
      }
    }
  }

  keys(ax: number, ay: number, bx: number, by: number): number[] {
    const out: number[] = [];
    for (let j = Math.floor(Math.min(ay, by) / this.bin); j <= Math.floor(Math.max(ay, by) / this.bin); j++) {
      for (let i = Math.floor(Math.min(ax, bx) / this.bin); i <= Math.floor(Math.max(ax, bx) / this.bin); i++) out.push(j * 1_000_003 + i);
    }
    return out;
  }

  /** Distance from p to the nearest segment, skipping some. */
  dist(px: number, py: number, skip: (i: number) => boolean): number {
    let best = Infinity;
    const { g } = this;
    for (const k of this.keys(px - 1, py - 1, px + 1, py + 1)) {
      for (const i of this.bins.get(k) ?? []) {
        if (skip(i)) continue;
        const d = g.down[i];
        const dx = g.x[d] - g.x[i];
        const dy = g.y[d] - g.y[i];
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - g.x[i]) * dx + (py - g.y[i]) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(g.x[i] + dx * t - px, g.y[i] + dy * t - py));
      }
    }
    return best;
  }

  /**
   * Proper crossings of a→b with stored segments: each segment's ends lie strictly on opposite sides of the
   * other's line. Node positions are Float32 (~1.5 cm at 500 km), so an end placed exactly on a channel may
   * land a hair past it: ends within 5 cm of the other line don't count.
   */
  crossings(ax: number, ay: number, bx: number, by: number, skip: (i: number) => boolean): number {
    let hits = 0;
    const { g } = this;
    const seen = new Set<number>();
    const side = (px: number, py: number, qx: number, qy: number, x: number, y: number): number => {
      const l = Math.hypot(qx - px, qy - py);
      return l > 0 ? ((qx - px) * (y - py) - (qy - py) * (x - px)) / l : 0;
    };
    const EPS = 0.05;
    for (const k of this.keys(ax, ay, bx, by)) {
      for (const i of this.bins.get(k) ?? []) {
        if (seen.has(i) || skip(i)) continue;
        seen.add(i);
        const d = g.down[i];
        const s1 = side(g.x[i], g.y[i], g.x[d], g.y[d], ax, ay);
        const s2 = side(g.x[i], g.y[i], g.x[d], g.y[d], bx, by);
        const s3 = side(ax, ay, bx, by, g.x[i], g.y[i]);
        const s4 = side(ax, ay, bx, by, g.x[d], g.y[d]);
        if (((s1 > EPS && s2 < -EPS) || (s1 < -EPS && s2 > EPS)) && ((s3 > EPS && s4 < -EPS) || (s3 < -EPS && s4 > EPS))) hits++;
      }
    }
    return hits;
  }
}

beforeAll(async () => {
  W = await buildWorld(7);
}, 60_000);

const TERMINAL = RIVER.CONFLUENCE | RIVER.MOUTH_SEA | RIVER.MOUTH_LAKE | RIVER.SINK_DRY;

for (const name of ['inland', 'coast'] as const) {
  describe(`close-zoom creeks, ${name} block (research 02 §8)`, () => {
    let B: Block;
    let input: CreekInput;
    let graph: RiverGraph;
    let owner: Int32Array;
    const cellOf = (x: number, y: number): number => {
      const { n, cellM } = W.input;
      return Math.min(n - 1, Math.max(0, Math.floor(y / cellM))) * n + Math.min(n - 1, Math.max(0, Math.floor(x / cellM)));
    };

    beforeAll(() => {
      B = W[name];
      input = { ...W.input, heightAt: B.heightAt };
      const ctx = prepareCreeks(input);
      const parts = B.cells.map((c) => ctx.cell(c));
      owner = new Int32Array(parts.reduce((s, p) => s + p.n, 0));
      let o = 0;
      parts.forEach((p, k) => owner.fill(B.cells[k], o, (o += p.n)));
      graph = generateCreeks(input, B.cells);
      let land = 0;
      for (const c of B.cells) if (ctx.hasCreeks(c)) land++;
      console.log(`[${name}] context`, { ...ctx.stats, thresholdKm2: ctx.thresholdKm2, step: ctx.step, landShare: land / B.cells.length, nodes: graph.n, reaches: graph.reachStart.length });
    });

    it('is identical per cell regardless of order and batching', () => {
      const ca = prepareCreeks({ ...input });
      const a = new Map<number, number[]>();
      for (const c of B.cells) a.set(c, cellHash(ca.cell(c)));
      // An independent context visiting the cells shuffled, in batches, with trunk-only calls interleaved.
      const cb = prepareCreeks({ ...input });
      expect(cb).not.toBe(ca);
      const order = B.cells.slice();
      let s = 12345;
      for (let i = order.length - 1; i > 0; i--) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const j = s % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let k = 0; k < order.length; k += 37) {
        const batch = order.slice(k, k + 37);
        for (const c of batch.slice().reverse()) cb.cell(c, { trunksOnly: true });
        for (const c of batch) expect(cellHash(cb.cell(c)), `cell ${c}`).toEqual(a.get(c));
      }
      // Trunk-only output is the leading reach of the full output.
      for (const c of B.cells.slice(0, 200)) {
        const t = cb.cell(c, { trunksOnly: true });
        const f = cb.cell(c);
        expect(Array.from(f.x.subarray(0, t.n))).toEqual(Array.from(t.x));
        expect(Array.from(f.zWater.subarray(0, t.n))).toEqual(Array.from(t.zWater));
      }
    });

    it('ends every creek on a channel, in water or in a sink', () => {
      const g = graph;
      const rivers = new Segs(W.input.rivers, 250);
      const creeks = new Segs(g, 250);
      const reachOf = new Int32Array(g.n);
      for (let r = 0; r < g.reachStart.length; r++) reachOf.fill(r, g.reachStart[r], g.reachStart[r] + g.reachLen[r]);
      let sources = 0;
      let ends = 0;
      let onChannel = 0;
      let water = 0;
      let sinks = 0;
      let dangling = 0;
      for (let i = 0; i < g.n; i++) {
        if (!W[name].inner.has(owner[i])) continue;
        if (g.flags[i] & RIVER.SOURCE) sources++;
        if (g.down[i] >= 0) continue;
        ends++;
        expect(g.flags[i] & TERMINAL, `end node ${i} has no terminal flag`).not.toBe(0);
        const cls = W.input.waterClass[cellOf(g.x[i], g.y[i])];
        if (g.flags[i] & (RIVER.MOUTH_SEA | RIVER.MOUTH_LAKE)) {
          expect([1, 2, 6]).toContain(cls);
          water++;
        } else if (g.flags[i] & RIVER.SINK_DRY) {
          sinks++;
        } else {
          // A confluence lies on the macro river, on another creek reach (incl. the next cell's trunk) or in a wide river.
          const r = reachOf[i];
          const dr = rivers.dist(g.x[i], g.y[i], () => false);
          const dc = creeks.dist(g.x[i], g.y[i], (k) => reachOf[k] === r);
          if (Math.min(dr, dc) < 0.5 || cls === 3) onChannel++;
          else dangling++;
        }
      }
      console.log(`[${name}] ends (inner cells)`, { sources, ends, onChannel, water, sinks, dangling });
      expect(ends).toBeGreaterThan(300);
      expect(dangling).toBe(0);
      expect(sinks).toBeLessThanOrEqual(Math.ceil(0.01 * ends));
      if (name === 'coast') expect(water).toBeGreaterThan(0);
    });

    it('keeps water monotone, reaches linked and areas below the macro channel threshold', () => {
      const g = graph;
      const th = prepareCreeks(input).thresholdKm2;
      for (let i = 0; i < g.n; i++) {
        const d = g.down[i];
        expect(g.zBed[i]).toBeLessThanOrEqual(g.zWater[i]);
        expect(g.area[i]).toBeLessThan(th);
        expect(g.width[i]).toBeGreaterThanOrEqual(1);
        expect(g.width[i]).toBeLessThanOrEqual(8);
        if (d >= 0) {
          expect(g.zWater[d], `edge ${i}→${d}`).toBeLessThanOrEqual(g.zWater[i]);
          expect(g.area[d] + 1e-6, `area ${i}→${d}`).toBeGreaterThanOrEqual(g.area[i]);
          expect(g.strahler[d]).toBeGreaterThanOrEqual(g.strahler[i]);
        }
      }
      for (let r = 0; r < g.reachStart.length; r++) {
        const last = g.reachStart[r] + g.reachLen[r] - 1;
        const rd = g.reachDown[r];
        expect(g.down[last]).toBe(rd < 0 ? -1 : g.reachStart[rd]);
      }
    });

    it('never crosses a macro river or another creek', () => {
      const g = graph;
      const rivers = new Segs(W.input.rivers, 250);
      const creeks = new Segs(g, 250);
      let riverX = 0;
      let creekX = 0;
      let segs = 0;
      for (let i = 0; i < g.n; i++) {
        const d = g.down[i];
        if (d < 0) continue;
        segs++;
        riverX += rivers.crossings(g.x[i], g.y[i], g.x[d], g.y[d], () => false);
        creekX += creeks.crossings(g.x[i], g.y[i], g.x[d], g.y[d], (k) => k === i || k === d || g.down[k] === i || g.down[k] === d || g.down[d] === k);
      }
      console.log(`[${name}] crossings`, { segments: segs, riverCrossings: riverX, creekCreekCrossings: creekX / 2 });
      expect(riverX).toBe(0);
      // Creeks never leave their cell and stop at the first channel they meet; trunks yield to larger trunks.
      expect(creekX).toBe(0);
    });

    it('generates a cell in well under a millisecond', () => {
      const c2 = prepareCreeks({ ...input });
      const t0 = performance.now();
      const g = generateCreeks(c2.input, B.cells);
      const ms = performance.now() - t0;
      let land = 0;
      for (const c of B.cells) if (c2.hasCreeks(c)) land++;
      let calls = 0;
      const counted: CreekInput = { ...input, heightAt: (x, y) => (calls++, input.heightAt(x, y)) };
      generateCreeks(counted, B.cells);
      const c3 = prepareCreeks({ ...input });
      const t1 = performance.now();
      generateCreeks(c3.input, B.cells, { trunksOnly: true });
      const trunkMs = performance.now() - t1;
      console.log(`[${name}] timing`, {
        cells: B.cells.length, landCells: land, msPerCell: +(ms / B.cells.length).toFixed(4), msPerLandCell: +(ms / Math.max(1, land)).toFixed(4),
        nodesPerLandCell: +(g.n / Math.max(1, land)).toFixed(1), heightAtCallsPerLandCell: Math.round(calls / Math.max(1, land)), trunkOnlyMsPerCell: +(trunkMs / B.cells.length).toFixed(4), prepareMs: +c2.stats.prepareMs.toFixed(1),
      });
      expect(ms / Math.max(1, land)).toBeLessThan(0.3);
    });
  });
}

describe('CreekManager', () => {
  it('time-slices, publishes partial graphs and goes quiet when the view is still', () => {
    const m = new CreekManager();
    const B = W.inland;
    m.setWorld(W.input, B.heightAt);
    const ctx = m.context!;
    const mid = B.cells[Math.floor(B.cells.length / 2) + SIDE / 2];
    const cx = ((mid % W.input.n) + 0.5) * ctx.cellM;
    const cy = (Math.floor(mid / W.input.n) + 0.5) * ctx.cellM;
    // A 20 km wide view on a 2560 px canvas: 7.8 m/px, ~11.5 km to the corners.
    const view = { centerX: cx, centerY: cy, radiusM: 11_500, metresPerPixel: 7.8 };
    let graphs = 0;
    let last: RiverGraph | null = null;
    let worst = 0;
    let frames = 0;
    for (; frames < 400; frames++) {
      const t0 = performance.now();
      const g = m.update(view);
      worst = Math.max(worst, performance.now() - t0);
      if (g) {
        graphs++;
        last = g;
      }
      if (m.stats.pending === 0 && !g && frames > 0) break;
    }
    expect(last).not.toBeNull();
    expect(last!.n).toBeGreaterThan(1000);
    const t0 = performance.now();
    for (let k = 0; k < 100; k++) expect(m.update(view)).toBeNull();
    const idle = (performance.now() - t0) / 100;
    console.log('[manager] 20 km view @7.8 m/px', {
      frames, graphs, cells: m.stats.desired, nodes: last!.n, reaches: last!.reachStart.length,
      worstUpdateMs: +worst.toFixed(2), idleUpdateMs: +idle.toFixed(4), mergeMs: +m.stats.mergeMs.toFixed(2),
    });
    expect(worst).toBeLessThan(12);
    expect(idle).toBeLessThan(0.05);
    // The merged graph is exactly the per-cell outputs (cache hits give the same bytes as fresh generation).
    expect(hashBytes(last!.x)).toBe(hashBytes(generateCreeks({ ...W.input, heightAt: B.heightAt }, Array.from(new Set(cellsOf(last!, ctx.cellM, W.input.n))).sort((a, b) => a - b)).x));

    // Tilted view: the eye 6 km south-west and 3 km up; far cells drop to trunks or nothing.
    const tilted = { ...view, radiusM: 30_000, eye: { x: cx - 4000, y: cy + 4000, z: 3000 } };
    let gt: RiverGraph | null = null;
    for (let k = 0; k < 400; k++) {
      const g = m.update(tilted);
      if (g) gt = g;
      if (m.stats.pending === 0 && !g) break;
    }
    console.log('[manager] tilted view, 30 km radius', { cells: m.stats.desired, nodes: gt?.n ?? 0 });

    // Zoomed out to 40 m/px over ~100 km: trunks only, where their area is visible.
    const wide = { ...view, radiusM: 60_000, metresPerPixel: 40 };
    let g40: RiverGraph | null = null;
    for (let k = 0; k < 400; k++) {
      const g = m.update(wide);
      if (g) g40 = g;
      if (m.stats.pending === 0 && !g) break;
    }
    console.log('[manager] 100 km view @40 m/px', { cells: m.stats.desired, nodes: g40?.n ?? 0 });
    expect(g40).not.toBeNull();
    // Far out: an empty graph once, then nothing.
    const far = { ...view, radiusM: 200_000, metresPerPixel: 200 };
    const g = m.update(far);
    expect(g?.n).toBe(0);
    expect(m.update({ ...far, metresPerPixel: 300 })).toBeNull();
  });
});

/** Cells owning a merged graph's reach heads (to rebuild it independently). */
function cellsOf(g: RiverGraph, cellM: number, n: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < g.reachStart.length; r++) {
    const i = g.reachStart[r];
    if (!(g.flags[i] & RIVER.SOURCE)) continue;
    out.push(Math.floor(g.y[i] / cellM) * n + Math.floor(g.x[i] / cellM));
  }
  return out;
}
