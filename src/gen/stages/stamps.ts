import type { Layer } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { angle, asCube, cellOfDir, type CubeGrid } from '../grid/cube';
import { cellIndex, cellX, cellY, type Grid } from '../grid/grid';
import { areaQuantile } from '../grid/ops';
import { upliftForPeak } from '../lem/streamPower';
import type { StageCtx, StageDef } from '../pipeline';
import { K0, LEM_M, type BaseExtra } from './base';
import { B, gaussian, shapeHeader, type PlatesExtra } from './plates';

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
    const N = g.cells;
    const h = base.h0.slice();
    const U = base.U.slice();
    const K = base.K;
    const volcanism = ctx.num('volcanism') * ctx.num('density_volcanic');

    const stats = g.shape === 'sphere'
      ? sphereStamps(ctx, P, asCube(g), asCube(pg), h, U, volcanism)
      : flatStamps(ctx, P, g, pg, h, U, volcanism);

    // Sea level again: stamps created and removed land.
    const sea = areaQuantile(h, g, 1 - ctx.num('landFraction'));
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
    const sh = shapeHeader(g);
    const layers: Layer[] = [
      { id: 'h0', label: 'Initial elevation', stage: 'stamps', kind: 'elevation', w: n, h: n, worldKm, ...sh, unit: 'm', min: lo, max: hi, data: h },
      { id: 'uplift', label: 'Uplift', stage: 'stamps', kind: 'scalar', w: n, h: n, worldKm, ...sh, unit: 'mm/yr', min: 0, max: uMax, data: Umm },
    ];
    const extra: TerrainExtra = { n, cellKm, h, U, K, strata: base.strata, fixed };
    return { layers, stats, outcomes: {}, extra };
  },
};

type StampStats = { hotspotVolcanoes: number; arcVolcanoes: number; craters: number };

/** Hotspot chains, arc volcanoes and old craters on the flat map (positions in map km). */
function flatStamps(
  ctx: StageCtx, P: PlatesExtra, g: Grid, pg: Grid, h: Float32Array, U: Float32Array, volcanism: number,
): StampStats {
  const { n, cellKm, cellM } = g;
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
  return { hotspotVolcanoes, arcVolcanoes, craters };
}

/**
 * The same stamps on the sphere (research 10 §5.3): positions are unit vectors, profiles are evaluated
 * in tangent-plane charts, hotspot trails follow the plate's Euler rotation backwards (small-circle
 * arcs about its pole) and spacing tests use great-circle distances.
 */
function sphereStamps(
  ctx: StageCtx, P: PlatesExtra, g: CubeGrid, pg: CubeGrid, h: Float32Array, U: Float32Array, volcanism: number,
): StampStats {
  const { cellKm, cellM } = g;
  const Rk = g.radiusM / 1000;
  const kmBetween = (a: Float64Array, b: Float64Array): number => Rk * angle(a, b);

  const cone = (p: Float64Array, radiusKm: number, summitM: number, upliftShare: number): boolean => {
    const c = cellOfDir(g, p[0], p[1], p[2]);
    const floor = h[c];
    const rise = summitM - floor;
    if (rise <= 0) return false;
    const uPeak = upliftShare > 0 ? upliftShare * upliftForPeak(Math.max(300, summitM), K0, LEM_M, radiusKm * 1000, cellM) : 0;
    g.chartDir(p, radiusKm * 1.6 * 1000, (i, e, nn) => {
      const t = Math.hypot(e, nn) / 1000 / radiusKm;
      if (t >= 1) return;
      h[i] += rise * (1 - t) ** 1.6;
      U[i] += uPeak * (1 - t * t);
    });
    return true;
  };

  let hotspotVolcanoes = 0;
  const hrng = ctx.rng('hotspots');
  const hotspots = ctx.drawn('hotspotCount');
  const w = P.omega!;
  for (let k = 0; k < hotspots; k++) {
    const p0 = pickDir(hrng, g, (c) => (hrng.float() < 0.75 ? h[c] < -1500 : h[c] > 0));
    if (!p0) continue;
    const pl = P.plate[cellOfDir(pg, p0[0], p0[1], p0[2])];
    const axis = Float64Array.from(w.subarray(pl * 3, pl * 3 + 3));
    const rate = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    for (let c = 0; c < 3; c++) axis[c] /= rate;
    // Surface speed at the hotspot (mm/yr = km/Myr) and its distance from the pole axis.
    const sinT = Math.max(1e-3, Math.hypot(axis[1] * p0[2] - axis[2] * p0[1], axis[2] * p0[0] - axis[0] * p0[2], axis[0] * p0[1] - axis[1] * p0[0]));
    const speed = rate * sinT || 1;
    const len = 3 + hrng.int(5);
    const spacing = hrng.range(45, 80);
    for (let j = 0; j < len; j++) {
      const ageMyr = (j * spacing) / speed;
      const p = rotate(p0, axis, -(j * spacing) / (Rk * sinT));
      const summit = (1500 + 1800 * volcanism * hrng.range(0.6, 1)) * Math.exp(-ageMyr / 6) - 900 * Math.sqrt(ageMyr);
      if (cone(p, hrng.range(22, 40) * (1 + 0.1 * j), summit, Math.exp(-ageMyr / 4))) hotspotVolcanoes++;
    }
  }

  let arcVolcanoes = 0;
  const arng = ctx.rng('arcs');
  const spacingKm = 55 / Math.max(0.2, volcanism);
  const placed: Float64Array[] = [];
  const candidates: { p: Float64Array; island: boolean }[] = [];
  for (let c = 0; c < pg.cells; c++) {
    const nb = P.nearest[c];
    const seg = P.bSeg[nb] >= 0 ? P.segments[P.bSeg[nb]] : null;
    if (!seg) continue;
    const d = P.dBKm[c];
    const onArc = seg.cls === B.ARC && seg.overriding === P.plate[c] && Math.abs(d - 130) < P.cellKm;
    const onCordillera = seg.cls === B.SUBDUCTION && P.continent[c] !== -1 && Math.abs(d - 170) < P.cellKm;
    if (!onArc && !onCordillera) continue;
    const p = new Float64Array(3);
    pg.position(c, p);
    candidates.push({ p, island: onArc });
  }
  shuffle(arng, candidates);
  for (const { p, island } of candidates) {
    if (volcanism <= 0.05) break;
    if (placed.some((q) => kmBetween(q, p) < spacingKm * arng.range(0.8, 1.3))) continue;
    const summit = island ? arng.range(500, 1900) : arng.range(2600, 4800);
    if (cone(p, island ? arng.range(10, 18) : arng.range(12, 20), summit, island ? 0.5 : 0.8)) {
      placed.push(p);
      arcVolcanoes++;
    }
  }

  let craters = 0;
  const crng = ctx.rng('craters');
  const [d0, d1] = ctx.range('craterDiameter');
  const minD = Math.max(d0, 4 * cellKm);
  const crPlaced: Float64Array[] = [];
  for (let k = 0; k < ctx.drawn('craterCount'); k++) {
    if (minD > d1) break;
    const D = Math.exp(crng.range(Math.log(minD), Math.log(d1)));
    const p = pickDir(crng, g, (c) => h[c] > 150, (q) => crPlaced.every((o) => kmBetween(o, q) > 150));
    if (!p) continue;
    crPlaced.push(p);
    craters++;
    const R = D / 2;
    const depth = D < 4 ? 0.2 * D * 1000 : 900 * (D / 4) ** 0.3;
    const rim = 0.036 * D * 1000;
    g.chartDir(p, R * 3 * 1000, (i, e, nn) => {
      const t = Math.hypot(e, nn) / 1000 / R;
      if (t < 1) {
        const bowl = -depth + (depth + rim) * t ** (D < 4 ? 2 : 4);
        const peak = D > 8 ? 0.35 * depth * Math.exp(-((t / 0.16) ** 2)) : 0;
        h[i] += bowl + peak;
      } else {
        h[i] += rim * t ** -3;
      }
    });
  }
  return { hotspotVolcanoes, arcVolcanoes, craters };
}

/** Random area-uniform direction whose cell satisfies `ok`; null after 200 tries. */
function pickDir(rng: Rng, g: CubeGrid, ok: (cell: number) => boolean, accept?: (p: Float64Array) => boolean): Float64Array | null {
  for (let t = 0; t < 200; t++) {
    const p = Float64Array.of(gaussian(rng), gaussian(rng), gaussian(rng));
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    for (let c = 0; c < 3; c++) p[c] /= len;
    if (ok(cellOfDir(g, p[0], p[1], p[2])) && (!accept || accept(p))) return p;
  }
  return null;
}

/** Rodrigues rotation of unit vector p about unit axis k by `a` radians. */
function rotate(p: Float64Array, k: Float64Array, a: number): Float64Array {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = (k[0] * p[0] + k[1] * p[1] + k[2] * p[2]) * (1 - c);
  return Float64Array.of(
    p[0] * c + (k[1] * p[2] - k[2] * p[1]) * s + k[0] * d,
    p[1] * c + (k[2] * p[0] - k[0] * p[2]) * s + k[1] * d,
    p[2] * c + (k[0] * p[1] - k[1] * p[0]) * s + k[2] * d,
  );
}

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
