import type { Layer } from '../../shared/protocol';
import { cellFace, cellIndex, cellX, cellY, type Grid } from '../grid/grid';
import { components } from '../grid/ops';
import { upsampleBicubic } from '../grid/upsample';
import { runLem, upliftRefineFactor, type LemParams } from '../lem/streamPower';
import type { StageCtx, StageDef } from '../pipeline';
import { LEM_M } from './base';
import { shapeHeader } from './plates';
import type { TerrainExtra } from './stamps';

export interface ErodedExtra extends TerrainExtra {
  /** Rain-weighted drainage area, m². */
  area: Float32Array;
  rcv: Int32Array;
}

/** Most a refine level may raise a cell above the upsampled coarse surface (m). */
const REFINE_RISE_M = 60;

/** Summit ceiling: heights above KNEE ease towards KNEE + SPAN (tanh), keeping order and smooth slopes. */
const SUMMIT_KNEE_M = 7600;
const SUMMIT_SPAN_M = 1400;

/** Land components at least this share of all land count as continents; smaller ones are islands. */
const CONTINENT_MIN_SHARE = 0.1;

const lemParams = (iterations: number): LemParams => ({
  m: LEM_M,
  dt: 2.5e5,
  iterations,
  kd: 1,
  talus: 0.5,
  stochasticIterations: Math.round(iterations * 0.4),
  diffusionOffLast: Math.min(10, Math.round(iterations * 0.15)),
});

/**
 * S4 Landscape evolution on the LEM grid: uplift + stream-power incision + diffusion + talus
 * (Braun & Willett 2013, research 01 §3). Mountains get their dendritic ridges and valleys here.
 */
export const lemStage: StageDef = {
  id: 'lem',
  label: 'Erosion',
  inputs: ['stamps'],
  reads: ['worldSize', 'lemIterations'],
  async run(ctx) {
    const t = ctx.input('stamps').extra as TerrainExtra;
    const iterations = ctx.mode === 'preview' ? Math.round(ctx.num('lemIterations') * 0.6) : ctx.num('lemIterations');
    const out = await erode(ctx, t, t.h.slice(), iterations);
    const layers = [elevationLayer('lemElevation', 'Eroded elevation (erosion grid)', 'lem', out, ctx.num('worldSize'), ctx.grid(t.n))];
    return { layers, stats: { iterations, ms: out.ms }, outcomes: {}, extra: out.extra };
  },
};

/**
 * S5 Refine: bicubic upsample to the macro grid, a few more erosion iterations to sharpen the finer
 * valleys, then the optional post-erosion sea-level rise that drowns valleys into rias.
 */
export const refineStage: StageDef = {
  id: 'refine',
  label: 'Refine',
  inputs: ['lem'],
  reads: ['worldSize', 'macroGrid', 'seaLevelRise', 'lemIterations', 'faceGrid'],
  async run(ctx) {
    const src = ctx.input('lem').extra as ErodedExtra;
    const worldKm = ctx.num('worldSize');
    let cur: ErodedExtra = src;
    let ms = 0;
    const sphere = ctx.grid(src.n).shape === 'sphere';
    const target = ctx.mode === 'preview' ? src.n : Number(ctx.str(sphere ? 'faceGrid' : 'macroGrid'));
    while (cur.n < target) {
      const n = cur.n * 2;
      const cg = ctx.grid(cur.n);
      const h = upsampleBicubic(cur.h, cg, 2);
      const U = upsampleBicubic(cur.U, cg, 2);
      // Halving the cell size raises the steady-state relief of the same uplift; rescale so the
      // refined summits keep the heights the erosion grid reached.
      const uScale = upliftRefineFactor(cur.cellKm * 1000, cur.cellKm * 500, LEM_M);
      for (let i = 0; i < U.length; i++) U[i] *= uScale;
      const K = upsampleBicubic(cur.K, cg, 2);
      const strata = upsampleBicubic(cur.strata, cg, 2);
      // Sub-cell jitter so flow on flat ground doesn't lock onto the new grid's axes.
      const fg = ctx.grid(n);
      const jit = ctx.rng('refine-jitter', n);
      for (let i = 0; i < fg.cells; i++) if (h[i] > 0) h[i] += 4 * (jit.float() - 0.5);
      const fixed = new Uint8Array(fg.cells);
      for (let i = 0; i < fg.cells; i++) {
        const parent = cur.fixed[cellIndex(cg, Math.floor(cellX(fg, i) / 2), Math.floor(cellY(fg, i) / 2), cellFace(fg, i))];
        fixed[i] = parent || h[i] <= 0 ? 1 : 0;
        if (fixed[i] && h[i] > 0 && parent) h[i] = Math.min(h[i], 0);
        if (U[i] < 0) U[i] = 0;
      }
      const iterations = Math.max(10, Math.round(ctx.num('lemIterations') * 0.3));
      const up = h.slice();
      const r = await erode(ctx, { n, cellKm: cur.cellKm / 2, h, U, K, strata, fixed }, h, iterations);
      ms += r.ms;
      // Refinement carves finer valleys; it must not raise summits above the coarse surface.
      for (let i = 0; i < fg.cells; i++) r.extra.h[i] = Math.min(r.extra.h[i], up[i] + REFINE_RISE_M);
      cur = r.extra;
    }

    const rise = ctx.num('seaLevelRise');
    const h = cur.h.slice();
    const fixed = cur.fixed.slice();
    if (rise > 0) {
      for (let i = 0; i < h.length; i++) {
        h[i] -= rise;
        if (h[i] <= 0) fixed[i] = 1;
      }
    }
    for (let i = 0; i < h.length; i++) {
      if (h[i] > SUMMIT_KNEE_M) h[i] = SUMMIT_KNEE_M + SUMMIT_SPAN_M * Math.tanh((h[i] - SUMMIT_KNEE_M) / SUMMIT_SPAN_M);
    }
    const final: ErodedExtra = { ...cur, h, fixed };
    const n = final.n;
    const fg = ctx.grid(n);
    const land = new Uint8Array(fg.cells);
    let landCells = 0;
    let landArea = 0;
    let peak = 0;
    for (let i = 0; i < fg.cells; i++) {
      if (h[i] > 0) {
        land[i] = 1;
        landCells++;
        if (sphere) landArea += fg.area(i);
        peak = Math.max(peak, h[i]);
      }
    }
    const { label, sizes } = components(land, fg);
    if (sphere) {
      // Continents and islands by area: cube-sphere cells differ by up to √2 (research 10 §5.5).
      const areas = new Float64Array(sizes.length);
      for (let i = 0; i < fg.cells; i++) if (label[i] >= 0) areas[label[i]] += fg.area(i);
      for (let k = 0; k < sizes.length; k++) sizes[k] = (areas[k] / landArea) * landCells;
    }
    const continents = sizes.filter((s) => s >= CONTINENT_MIN_SHARE * landCells).length;
    const islands = sizes.length - continents;
    const layers: Layer[] = [elevationLayer('elevation', 'Elevation', 'refine', { extra: final }, worldKm, fg), drainageLayer(final, worldKm, fg)];
    return {
      layers,
      stats: { landFraction: sphere ? landArea / fg.totalArea : landCells / (n * n), continents, islands, highestPeakM: peak, ms },
      outcomes: { continentCount: continents },
      extra: final,
    };
  },
};

async function erode(ctx: StageCtx, t: TerrainExtra, h: Float32Array, iterations: number): Promise<{ extra: ErodedExtra; ms: number }> {
  const r = await runLem(
    { grid: ctx.grid(t.n), h, U: t.U, K: t.K, fixed: t.fixed, strata: { thickness: t.strata, capFraction: 0.3, softRatio: 4 } },
    lemParams(iterations),
    ctx.rng('lem', t.n),
    () => ctx.checkpoint(),
  );
  return { extra: { ...t, h: r.h, area: r.area, rcv: r.rcv }, ms: r.ms };
}

function elevationLayer(id: string, label: string, stage: 'lem' | 'refine', r: { extra: ErodedExtra }, worldKm: number, g: Grid): Layer {
  const { h, n } = r.extra;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { id, label, stage, kind: 'elevation', w: n, h: n, worldKm, ...shapeHeader(g), unit: 'm', min: lo, max: hi, data: h };
}

function drainageLayer(e: ErodedExtra, worldKm: number, g: Grid): Layer {
  const { n, area, fixed } = e;
  const data = new Float32Array(g.cells);
  let hi = 0;
  for (let i = 0; i < g.cells; i++) {
    data[i] = fixed[i] ? 0 : Math.log10(Math.max(1, area[i] / 1e6));
    hi = Math.max(hi, data[i]);
  }
  return { id: 'drainage', label: 'Drainage area (log10 km²)', stage: 'refine', kind: 'scalar', w: n, h: n, worldKm, ...shapeHeader(g), unit: '', min: 0, max: hi, data };
}
