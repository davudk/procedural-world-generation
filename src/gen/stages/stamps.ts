import type { Layer } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { cellIndex, cellX, cellY, type Grid } from '../grid/grid';
import { quantile } from '../grid/ops';
import { upliftForPeak } from '../lem/streamPower';
import type { StageDef } from '../pipeline';
import { K0, LEM_M, type BaseExtra } from './base';
import { B, type PlatesExtra } from './plates';

export interface TerrainExtra {
  n: number;
  cellKm: number;
  h: Float32Array;
  U: Float32Array;
  K: Float32Array;
  strata: Float32Array;
  /** 1 = base level (ocean, or an open map edge): fixed during erosion. */
  fixed: Uint8Array;
}

interface Point {
  x: number;
  y: number;
}

/**
 * S3 Pre-erosion stamps: hotspot chains, arc volcanoes and old impact craters, written into h0 and U
 * before the erosion model runs, so rivers and valleys respect them (research 01 §6, CONFIG.md L2).
 * Volcanoes get a cone of uplift so they survive erosion as dissected peaks; old hotspot volcanoes get
 * less and subside into seamounts. Sea level is re-applied afterwards, since stamps create land.
 */
export const stampsStage: StageDef = {
  id: 'stamps',
  label: 'Volcanoes & craters',
  inputs: ['plates', 'base'],
  reads: ['worldSize', 'landFraction', 'hotspotCount', 'volcanism', 'craterCount', 'craterDiameter', 'mapEdge', 'density_volcanic'],
  run(ctx) {
    const P = ctx.input('plates').extra as PlatesExtra;
    const base = ctx.input('base').extra as BaseExtra;
    const { n, cellKm } = base;
    const g = ctx.grid(n);
    const pg = ctx.grid(P.n);
    const cellM = g.cellM;
    const N = g.cells;
    const h = base.h0.slice();
    const U = base.U.slice();
    const K = base.K;
    const volcanism = ctx.num('volcanism') * ctx.num('density_volcanic');

    const cone = (p: Point, radiusKm: number, summitM: number, upliftShare: number): boolean => {
      const c = cellIndex(g, Math.floor(p.x / cellKm), Math.floor(p.y / cellKm));
      if (p.x < 0 || p.y < 0 || p.x >= n * cellKm || p.y >= n * cellKm) return false;
      const floor = h[c];
      const rise = summitM - floor;
      if (rise <= 0) return false;
      const uPeak = upliftShare > 0 ? upliftShare * upliftForPeak(Math.max(300, summitM), K0, LEM_M, radiusKm * 1000, cellM) : 0;
      stamp(g, p, radiusKm * 1.6, (r) => {
        const t = r / radiusKm;
        return t >= 1 ? [0, 0] : [rise * (1 - t) ** 1.6, uPeak * (1 - t * t)];
      }, h, U);
      return true;
    };

    // Hotspot chains: the youngest volcano is tallest; older ones trail along −v and subside.
    let hotspotVolcanoes = 0;
    const hrng = ctx.rng('hotspots');
    const hotspots = ctx.drawn('hotspotCount');
    for (let k = 0; k < hotspots; k++) {
      const p0 = pickPoint(hrng, g, (c) => (hrng.float() < 0.75 ? h[c] < -1500 : h[c] > 0));
      if (!p0) continue;
      const pl = P.plate[cellIndex(pg, Math.floor((p0.x / (n * cellKm)) * P.n), Math.floor((p0.y / (n * cellKm)) * P.n))];
      const vx = P.vx[pl];
      const vy = P.vy[pl];
      const speed = Math.hypot(vx, vy) || 1;
      const len = 3 + hrng.int(5);
      const spacing = hrng.range(45, 80);
      for (let j = 0; j < len; j++) {
        const ageMyr = (j * spacing) / speed;
        const p = { x: p0.x - (vx / speed) * j * spacing, y: p0.y - (vy / speed) * j * spacing };
        const summit = (1500 + 1800 * volcanism * hrng.range(0.6, 1)) * Math.exp(-ageMyr / 6) - 900 * Math.sqrt(ageMyr);
        if (cone(p, hrng.range(22, 40) * (1 + 0.1 * j), summit, Math.exp(-ageMyr / 4))) hotspotVolcanoes++;
      }
    }

    // Arc volcanoes behind subduction zones and island arcs (Poisson-disk along each arc).
    let arcVolcanoes = 0;
    const arng = ctx.rng('arcs');
    const spacingKm = 55 / Math.max(0.2, volcanism);
    const placed: Point[] = [];
    const candidates: { p: Point; island: boolean }[] = [];
    for (let c = 0; c < pg.cells; c++) {
      const nb = P.nearest[c];
      const seg = P.bSeg[nb] >= 0 ? P.segments[P.bSeg[nb]] : null;
      if (!seg) continue;
      const d = P.dBKm[c];
      const onArc = seg.cls === B.ARC && seg.overriding === P.plate[c] && Math.abs(d - 130) < P.cellKm;
      const onCordillera = seg.cls === B.SUBDUCTION && P.continent[c] !== -1 && Math.abs(d - 170) < P.cellKm;
      if (onArc || onCordillera) candidates.push({ p: { x: (cellX(pg, c) + 0.5) * P.cellKm, y: (cellY(pg, c) + 0.5) * P.cellKm }, island: onArc });
    }
    shuffle(arng, candidates);
    for (const { p, island } of candidates) {
      if (volcanism <= 0.05) break;
      if (placed.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < (spacingKm * arng.range(0.8, 1.3)) ** 2)) continue;
      const summit = island ? arng.range(500, 1900) : arng.range(2600, 4800);
      if (cone(p, island ? arng.range(10, 18) : arng.range(12, 20), summit, island ? 0.5 : 0.8)) {
        placed.push(p);
        arcVolcanoes++;
      }
    }

    // Old impact craters on land: degraded later by erosion (fresh craters come after erosion, M6).
    let craters = 0;
    const crng = ctx.rng('craters');
    const [d0, d1] = ctx.range('craterDiameter');
    const minD = Math.max(d0, 4 * cellKm);
    const crPlaced: Point[] = [];
    for (let k = 0; k < ctx.drawn('craterCount'); k++) {
      if (minD > d1) break;
      const D = Math.exp(crng.range(Math.log(minD), Math.log(d1)));
      const p = pickPoint(crng, g, (c) => h[c] > 150, (q) => crPlaced.every((o) => Math.hypot(o.x - q.x, o.y - q.y) > 150));
      if (!p) continue;
      crPlaced.push(p);
      craters++;
      const R = D / 2;
      const depth = D < 4 ? 0.2 * D * 1000 : 900 * (D / 4) ** 0.3;
      const rim = 0.036 * D * 1000;
      stamp(g, p, R * 3, (r) => {
        const t = r / R;
        if (t < 1) {
          const bowl = -depth + (depth + rim) * t ** (D < 4 ? 2 : 4);
          const peak = D > 8 ? 0.35 * depth * Math.exp(-((t / 0.16) ** 2)) : 0;
          return [bowl + peak, 0];
        }
        return [rim * t ** -3, 0];
      }, h, U);
    }

    // Sea level again: stamps created and removed land.
    const sea = quantile(h, 1 - ctx.num('landFraction'));
    const fixed = new Uint8Array(N);
    // An open map edge (mapEdge = continent) is base level: water leaves the map there.
    const outlets = ctx.str('mapEdge') === 'continent' ? g.outlets : null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < N; i++) {
      h[i] -= sea;
      fixed[i] = h[i] <= 0 || (outlets !== null && outlets[i] === 1) ? 1 : 0;
      lo = Math.min(lo, h[i]);
      hi = Math.max(hi, h[i]);
    }
    const Umm = Float32Array.from(U, (u) => u * 1000);
    let uMax = 0;
    for (const u of Umm) uMax = Math.max(uMax, u);
    const worldKm = ctx.num('worldSize');
    const layers: Layer[] = [
      { id: 'h0', label: 'Initial elevation', stage: 'stamps', kind: 'elevation', w: n, h: n, worldKm, unit: 'm', min: lo, max: hi, data: h },
      { id: 'uplift', label: 'Uplift', stage: 'stamps', kind: 'scalar', w: n, h: n, worldKm, unit: 'mm/yr', min: 0, max: uMax, data: Umm },
    ];
    const extra: TerrainExtra = { n, cellKm, h, U, K, strata: base.strata, fixed };
    return { layers, stats: { hotspotVolcanoes, arcVolcanoes, craters }, outcomes: {}, extra };
  },
};

/** Adds a radial profile `f(rKm) → [Δh, ΔU]` around `p` (km) within `reachKm`. */
function stamp(
  g: Grid, p: Point, reachKm: number,
  f: (rKm: number) => readonly [number, number], h: Float32Array, U: Float32Array,
): void {
  const { n, cellKm } = g;
  const x0 = Math.max(0, Math.floor((p.x - reachKm) / cellKm));
  const x1 = Math.min(n - 1, Math.ceil((p.x + reachKm) / cellKm));
  const y0 = Math.max(0, Math.floor((p.y - reachKm) / cellKm));
  const y1 = Math.min(n - 1, Math.ceil((p.y + reachKm) / cellKm));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const r = Math.hypot((x + 0.5) * cellKm - p.x, (y + 0.5) * cellKm - p.y);
      if (r > reachKm) continue;
      const [dh, du] = f(r);
      const i = cellIndex(g, x, y);
      h[i] += dh;
      U[i] += du;
    }
  }
}

/** Random point (km) whose cell satisfies `ok`, away from the map border; null after 200 tries. */
function pickPoint(rng: Rng, g: Grid, ok: (cell: number) => boolean, accept?: (p: Point) => boolean): Point | null {
  const { n, cellKm } = g;
  for (let t = 0; t < 200; t++) {
    const x = rng.range(0.06, 0.94) * n * cellKm;
    const y = rng.range(0.06, 0.94) * n * cellKm;
    const c = cellIndex(g, Math.floor(x / cellKm), Math.floor(y / cellKm));
    if (ok(c) && (!accept || accept({ x, y }))) return { x, y };
  }
  return null;
}

function shuffle<T>(rng: Rng, a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
}
