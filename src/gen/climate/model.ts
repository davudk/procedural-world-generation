import type { Noise2 } from '../../shared/noise';
import type { Noise3 } from '../../shared/noise3';
import { asCube, latitudes } from '../grid/cube';
import { cellFace, cellIndex, cellX, cellY, coarser, type Grid } from '../grid/grid';
import { chamferDistance, smoothstep } from '../grid/ops';
import { downsample, gaussBlur, upsample, warp } from '../grid/smooth';
import { advectMarine, advectMoisture, buildStencil } from './advect';
import { sstAnomaly } from './currents';
import { coarseFbm, expNeg } from './fields';
import { windToFace } from './sphere';
import { ampLand, ampOcean, capacity, circulation, HALF_YEAR, LAPSE, zonalT } from './tables';
import { windField, type Wind, type WindOptions } from './wind';

/** Constants of research 03 §2.3 that are not exposed as parameters. */
const L_MARINE = 400; // km, continentality e-folding inland
const SEA_BREEZE = 60; // km
const L_EVAP = 300; // km, recharge distance over the sea
const RH_SEA = 0.85;
const RH_MAX = 1.0;
/**
 * e-folding distance (km) over which supersaturated air snows out its excess. The research's
 * ETA_SAT = 0.5 per cell is grid-dependent and, through P = P0·Δq·L_RAIN/ds, turns a 1-cell snow-out
 * into 10⁴–10⁵ mm/yr spikes; a distance keeps it comparable to the capped orographic term.
 */
const L_SAT = 250;
const CONTINENT_Q = 0.35;
/** Summer bands sit 5° poleward of their annual position, winter bands 4° equatorward (§2.2). */
const SUMMER_SHIFT = -5;
const WINTER_SHIFT = 4;
const HOLDRIDGE = 58.93;
/**
 * Coarsest cell (km) of the moisture sweeps. Precipitation is blurred by σ 8 km and the uplift term
 * reads a σ 5 km blurred DEM, so sweeping finer than 2 km only costs time.
 */
const SWEEP_KM = 2;
/** Spheres: the precipitation blur is at least this many sweep cells (σ), whatever the 8 km storm scale gives. */
const SPHERE_STORM_CELLS = 1;
/**
 * Cross-wind mixing (km, σ) and streamline meander (km, ± displacement at WARP_WAVE_KM). The upwind
 * sweeps have almost no cross-wind diffusion, so under a uniform wind the edge of a coastal air mass
 * (marine influence → temperature range) or a rain shadow travels hundreds of km as a narrow front
 * along a straight streamline, and every isoline derived from it (treeline, snowline, the renderer's
 * colour LUT) becomes a straight seam — often exactly N–S or E–W where the band winds are near an
 * axis (research 03 §7.5). Real air masses mix laterally over ~100 km and their paths meander.
 */
const MIX_Q_KM = 30;
const MIX_MARINE_KM = 80;
const MIX_SEASON_KM = 40;
const WARP_KM = 35;
const WARP_WAVE_KM = 250;

export interface ClimateParams {
  latNorth: number;
  latSouth: number;
  tempOffset: number;
  gradient: number;
  humidity: number;
  /** L_RAIN (km). */
  moistureLength: number;
  seasonality: number;
  windOverrideAngle: number;
  windOverrideStrength: number;
  oceanCurrents: boolean;
  /** mapEdge: what lies beyond the map (boundary inflow of the sweeps). */
  outsideOcean: boolean;
  latitudeWarp: number;
  windNoise: number;
  orographicStrength: number;
  rainShadowCap: number;
  recycling: number;
}

export interface ClimateFields {
  /** 1 = sea (fixed base level at or below 0 m). */
  sea: Uint8Array;
  /** Warped latitude φ_eff (°). */
  lat: Float32Array;
  temp: Float32Array;
  tAmp: Float32Array;
  precip: Float32Array;
  pSummer: Float32Array;
  pet: Float32Array;
  marine: Float32Array;
  coastKm: Float32Array;
  /** SST anomaly on sea cells, advected anomaly on land (°C). */
  sstAnom: Float32Array;
  fog: Uint8Array;
  /** Annual prevailing wind direction (degrees the wind blows toward, 0 = north, clockwise). */
  windDeg: Float32Array;
  stats: Record<string, number>;
}

/** Inputs of the seasonal sweeps, on the sweep grid. */
interface SweepGrid {
  grid: Grid;
  n: number;
  cellKm: number;
  sea: Uint8Array;
  lat: Float32Array;
  /** Mean land elevation (m, 0 on the sea) and its σ 5 km blur. */
  h: Float32Array;
  hs: Float32Array;
  coastKm: Float32Array;
  /** Sea-level temperature without current anomalies (°C), half-ranges over land and sea (°C). */
  tsl: Float32Array;
  ampL: Float32Array;
  ampO: Float32Array;
  anom: Float32Array;
}

interface SweepOut {
  /** Precipitation rate of the summer and winter runs (mm/yr). */
  ps: Float32Array;
  pw: Float32Array;
  /** Means of both runs: marine influence, advected anomaly, wind vector, fog flag. */
  m: Float32Array;
  a: Float32Array;
  /** Wind toward east and south (flat: also the grid axes; sphere: the local frame). */
  wx: Float32Array;
  wy: Float32Array;
  fog: Float32Array;
}

/**
 * Climate model of research 03 §1–2 on the macro grid: warped latitude, zonal temperature with lapse
 * rate, coastal current anomalies, continentality, and the summer and winter upwind moisture sweeps
 * (on a grid of ≥ SWEEP_KM cells) with orographic uplift, snow-out and recycling. On the sphere the
 * latitude is the true one (latNorth / latSouth are ignored), winds are turned from the local frame
 * into face axes and the sweeps follow the upwind graph round the planet (research 10 §5.6); `noise`
 * is then a Noise3.
 */
export async function computeClimate(
  h: Float32Array,
  fixed: Uint8Array,
  grid: Grid,
  p: ClimateParams,
  noise: Noise2 | Noise3,
  checkpoint: () => Promise<void>,
): Promise<ClimateFields> {
  const { n, cellKm } = grid;
  const N = grid.cells;
  const sphere = grid.shape === 'sphere';
  const stats: Record<string, number> = {};
  let tLap = performance.now();
  const lap = (key: string): void => {
    const now = performance.now();
    stats[`ms_${key}`] = Math.round((now - tLap) * 10) / 10;
    tLap = now;
  };

  // 1. Full-resolution masks and latitude, then the sweep grid.
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) sea[i] = fixed[i] && h[i] <= 0 ? 1 : 0;
  const lat = coarseFbm(noise, grid, 500, 3, 0.37);
  if (sphere) {
    const trueLat = latitudes(asCube(grid));
    for (let i = 0; i < N; i++) lat[i] = trueLat[i] + 2 * p.latitudeWarp * lat[i];
  } else {
    for (let y = 0; y < n; y++) {
      const base = p.latNorth + ((p.latSouth - p.latNorth) * (y + 0.5)) / n;
      // fBm rarely leaves ±0.5, so ×2 gives the research's ±warp degrees.
      for (let x = 0; x < n; x++) {
        const i = cellIndex(grid, x, y);
        lat[i] = base + 2 * p.latitudeWarp * lat[i];
      }
    }
  }
  const coastKm = chamferDistance(sea, grid);
  for (let i = 0; i < N; i++) coastKm[i] *= cellKm;
  let f = 1;
  while (f * 2 * cellKm <= SWEEP_KM && n % (f * 2) === 0 && n / (f * 2) >= 64) f *= 2;
  const g = sweepGrid(sea, h, lat, grid, f, p);
  stats.sweepGrid = g.n;
  lap('setup');
  await checkpoint();

  // 2. Summer and winter sweeps.
  const sw = await sweeps(g, p, noise, stats, checkpoint);
  tLap = performance.now();

  // 3. Post-processing on the sweep grid (storm-scale spreading, seasonality), then full resolution.
  // Spheres: at least one cell, so coarse planets (16–23 km preview cells) spread a one-cell snow-out
  // or uplift spike as finer grids do (research 11 §5); flat maps keep the 8 km storm scale.
  const stormCells = sphere ? Math.max(8 / g.cellKm, SPHERE_STORM_CELLS) : 8 / g.cellKm;
  gaussBlur(sw.ps, g.grid, stormCells);
  gaussBlur(sw.pw, g.grid, stormCells);
  const pC = new Float32Array(g.grid.cells);
  const psC = new Float32Array(g.grid.cells);
  for (let i = 0; i < pC.length; i++) {
    const tot = sw.ps[i] + sw.pw[i];
    pC[i] = tot / 2;
    psC[i] = tot > 1e-6 ? sw.ps[i] / tot : 0.5;
  }
  gaussBlur(psC, g.grid, MIX_SEASON_KM / g.cellKm);
  for (let i = 0; i < g.anom.length; i++) if (g.sea[i]) sw.a[i] = g.anom[i];
  gaussBlur(sw.m, g.grid, MIX_MARINE_KM / g.cellKm);
  gaussBlur(sw.a, g.grid, MIX_MARINE_KM / g.cellKm);
  // fBm rarely leaves ±0.5, so ×2 gives ±WARP_KM.
  const wx = coarseFbm(noise, g.grid, WARP_WAVE_KM, 2, 63.1);
  const wy = coarseFbm(noise, g.grid, WARP_WAVE_KM, 2, 77.9);
  for (let i = 0; i < wx.length; i++) {
    wx[i] *= (2 * WARP_KM) / g.cellKm;
    wy[i] *= (2 * WARP_KM) / g.cellKm;
  }
  const up = (cIn: Float32Array, bend = false): Float32Array => {
    const c = bend ? warp(cIn, g.grid, wx, wy) : cIn;
    if (f === 1) return c;
    const out = new Float32Array(N);
    upsample(c, g.grid, f, out);
    return out;
  };
  const precip = up(pC);
  const pSummer = up(psC, true);
  const marine = up(sw.m, true);
  const sstAnom = up(sw.a, true);
  const fogF = up(sw.fog);
  const tex = coarseFbm(noise, grid, 120, 3, 41.7);
  const temp = new Float32Array(N);
  const tAmp = new Float32Array(N);
  const pet = new Float32Array(N);
  const fog = new Uint8Array(N);
  const t0 = zonalT.at(0);
  for (let i = 0; i < N; i++) {
    // ±15 % mesoscale texture (fBm ≈ ±0.5).
    precip[i] *= Math.exp(0.3 * tex[i]);
    const s = sea[i];
    marine[i] = s ? 1 : Math.max(Math.min(1, marine[i]), Math.exp(-coastKm[i] / SEA_BREEZE));
    const aL = ampLand.at(lat[i]);
    const A = (aL + marine[i] * (ampOcean.at(lat[i]) - aL)) * p.seasonality;
    const t = t0 + p.gradient * (zonalT.at(lat[i]) - t0) + p.tempOffset + sstAnom[i] - LAPSE * (s ? 0 : Math.max(0, h[i]));
    temp[i] = t;
    tAmp[i] = A;
    const bt = t - A >= 0 && t + A <= 30 ? t : excess(t, A, 0) - excess(t, A, 30);
    pet[i] = HOLDRIDGE * bt;
    fog[i] = !s && fogF[i] >= 0.5 ? 1 : 0;
  }
  const windDeg = new Float32Array(N);
  if (sphere) {
    for (let i = 0; i < N; i++) {
      const c = cellIndex(g.grid, Math.floor(cellX(grid, i) / f), Math.floor(cellY(grid, i) / f), cellFace(grid, i));
      const d = (Math.atan2(sw.wx[c], -sw.wy[c]) * 180) / Math.PI;
      windDeg[i] = d < 0 ? d + 360 : d;
    }
  } else {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = cellIndex(g.grid, Math.floor(x / f), Math.floor(y / f));
        const d = (Math.atan2(sw.wx[c], -sw.wy[c]) * 180) / Math.PI;
        windDeg[cellIndex(grid, x, y)] = d < 0 ? d + 360 : d;
      }
    }
  }
  lap('post');
  return { sea, lat, temp, tAmp, precip, pSummer, pet, marine, coastKm, sstAnom, fog, windDeg, stats };
}

function sweepGrid(sea: Uint8Array, h: Float32Array, lat: Float32Array, grid: Grid, f: number, p: ClimateParams): SweepGrid {
  const { cellKm } = grid;
  const sg = coarser(grid, f);
  const m = sg.n;
  const M = sg.cells;
  const seaF = new Float32Array(grid.cells);
  const land = new Float32Array(grid.cells);
  for (let i = 0; i < grid.cells; i++) {
    seaF[i] = sea[i];
    land[i] = sea[i] ? 0 : Math.max(0, h[i]);
  }
  const fr = f === 1 ? seaF : downsample(seaF, grid, f);
  const gs = new Uint8Array(M);
  for (let i = 0; i < M; i++) gs[i] = fr[i] >= 0.5 ? 1 : 0;
  const gh = f === 1 ? land : downsample(land, grid, f);
  const glat = f === 1 ? lat : downsample(lat, grid, f);
  const ck = cellKm * f;
  const hs = gh.slice();
  gaussBlur(hs, sg, 5 / ck);
  const coastKm = chamferDistance(gs, sg);
  const tsl = new Float32Array(M);
  const ampL = new Float32Array(M);
  const ampO = new Float32Array(M);
  const t0 = zonalT.at(0);
  for (let i = 0; i < M; i++) {
    coastKm[i] *= ck;
    tsl[i] = t0 + p.gradient * (zonalT.at(glat[i]) - t0) + p.tempOffset;
    ampL[i] = ampLand.at(glat[i]) * p.seasonality;
    ampO[i] = ampOcean.at(glat[i]) * p.seasonality;
  }
  const anom = p.oceanCurrents ? sstAnomaly(gs, glat, sg, !p.outsideOcean) : new Float32Array(M);
  return { grid: sg, n: m, cellKm: ck, sea: gs, lat: glat, h: gh, hs, coastKm, tsl, ampL, ampO, anom };
}

async function sweeps(g: SweepGrid, p: ClimateParams, noise: Noise2 | Noise3, stats: Record<string, number>, checkpoint: () => Promise<void>): Promise<SweepOut> {
  const { grid, cellKm, sea, lat, h, hs, coastKm, tsl, ampL, ampO, anom } = g;
  const N = grid.cells;
  // Hothouse worlds (flat gradients) also flatten the circulation contrast (research 03 §7.4).
  const sContrast = Math.min(1.2, Math.max(0.5, 0.25 + 0.75 * p.gradient));
  const p0 = 1200 * p.humidity;
  const lRain = p.moistureLength;
  const kOro = p.orographicStrength;
  const upMax = p.rainShadowCap;
  const out: SweepOut = {
    ps: new Float32Array(N), pw: new Float32Array(N), m: new Float32Array(N), a: new Float32Array(N),
    wx: new Float32Array(N), wy: new Float32Array(N), fog: new Float32Array(N),
  };
  const m = new Float32Array(N);
  const a = new Float32Array(N);
  const q = new Float32Array(N);
  const bm = new Float32Array(N);
  const bq = new Float32Array(N);
  const divLine = new Uint8Array(N);
  const decay = new Float32Array(N);
  const target = new Float32Array(N);
  const recharge = new Float32Array(N);
  const deplete = new Float32Array(N);
  const cap = new Float32Array(N);
  const retain = new Float32Array(N);
  const recycle = new Float32Array(N);
  // First guesses; the winter sweep starts from the summer m and a.
  for (let i = 0; i < N; i++) m[i] = sea[i] ? 1 : expNeg(coastKm[i] / L_MARINE);
  for (let season = 0; season < 2; season++) {
    const t = performance.now();
    const summer = season === 0;
    const sgn = summer ? 1 : -1;
    const shift = (summer ? SUMMER_SHIFT : WINTER_SHIFT) * p.seasonality;
    const wind = coarseWind(lat, grid, coarseFbm(noise, grid, 300, 2, summer ? 11.3 : 23.9), {
      shiftDeg: shift, noiseRad: (2 * p.windNoise * Math.PI) / 180, overrideDeg: p.windOverrideAngle, overrideStrength: p.windOverrideStrength,
    });
    const st = buildStencil(wind, grid);
    for (let i = 0; i < N; i++) {
      out.wx[i] += wind.ex?.[i] ?? wind.gx[i];
      out.wy[i] += wind.sy?.[i] ?? wind.gy[i];
      decay[i] = expNeg(st.ds[i] / L_MARINE);
    }
    // Inflow where a cell has no upwind neighbour. Map edge: marine air from an ocean beyond the map
    // (half-marine where the edge is land, research 03 §7.5), continental air otherwise. Divergence
    // lines: air from aloft, at the sweep's first-guess values (set in the prep loop below).
    divLine.fill(0);
    for (const i of st.sources) {
      if (!grid.hasOutside || !grid.border[i]) {
        divLine[i] = 1;
        bm[i] = sea[i] ? 1 : expNeg(coastKm[i] / L_MARINE);
        continue;
      }
      const marineQ = RH_SEA * capacity(tsl[i] + anom[i] + sgn * HALF_YEAR * ampO[i]);
      const w = !p.outsideOcean ? 0 : sea[i] ? 1 : 0.5;
      bm[i] = w;
      bq[i] = CONTINENT_Q + w * (marineQ - CONTINENT_Q);
    }
    stats[`roundsMarine${season}`] = advectMarine(st, { sea, anom, decay, boundaryM: bm }, m, a);
    await checkpoint();

    for (let i = 0; i < N; i++) {
      const A = ampL[i] + m[i] * (ampO[i] - ampL[i]);
      const tSeason = tsl[i] + (sea[i] ? anom[i] : a[i]) + sgn * HALF_YEAR * A;
      const ds = st.ds[i];
      let S = 1 + (circulation.at(Math.abs(lat[i]) + shift) - 1) * sContrast;
      if (sea[i]) {
        target[i] = RH_SEA * capacity(tSeason);
        recharge[i] = expNeg(ds / L_EVAP);
        deplete[i] = expNeg((S * ds) / lRain);
        q[i] = target[i];
      } else {
        const absLat = Math.abs(lat[i]);
        if (coastKm[i] < SEA_BREEZE && a[i] < -2 && absLat >= 12 && absLat <= 32) {
          S *= 0.3;
          out.fog[i] += 0.5;
        }
        const u = st.iu[i];
        const j = st.ju[i];
        const hin = st.wa[i] * (u < 0 ? hs[i] : hs[u]) + (1 - st.wa[i]) * (j < 0 ? hs[i] : hs[j]);
        const rise = Math.min(Math.max(hs[i] - hin, 0) / ds, upMax);
        deplete[i] = expNeg(((S + kOro * rise) * ds) / lRain);
        cap[i] = capacity(tSeason - LAPSE * hs[i]) * RH_MAX;
        retain[i] = expNeg(ds / L_SAT);
        recycle[i] = p.recycling * smoothstep(-5, 10, tSeason - LAPSE * h[i]);
        q[i] = 0.5 * RH_SEA * cap[i];
      }
      if (divLine[i]) bq[i] = q[i];
    }
    stats[`roundsMoisture${season}`] = advectMoisture(
      st, { sea, target, recharge, deplete, cap, retain, recycle, boundaryQ: bq }, p0, lRain, MIX_Q_KM / cellKm, q, summer ? out.ps : out.pw,
    );
    for (let i = 0; i < N; i++) {
      out.m[i] += 0.5 * m[i];
      out.a[i] += 0.5 * a[i];
    }
    stats[`ms_${summer ? 'summer' : 'winter'}`] = Math.round((performance.now() - t) * 10) / 10;
    await checkpoint();
  }
  return out;
}

/**
 * Wind bands evaluated on a ≤ 8 km lattice and bilinearly upsampled: the field only varies on the
 * 300–500 km scales of the latitude warp and direction noise, so per-cell trigonometry is wasted.
 * On the sphere the bands are upsampled in the local (east, south) frame, which is continuous across
 * the seams, and then turned into face axes; `ex` / `sy` keep the local components.
 */
function coarseWind(
  lat: Float32Array,
  grid: Grid,
  dirNoise: Float32Array,
  o: Omit<WindOptions, 'noise'> & { noiseRad: number },
): Wind & { ex?: Float32Array; sy?: Float32Array } {
  if (grid.shape === 'sphere') {
    const w = coarseWindFlatFrame(lat, grid, dirNoise, o);
    const ex = w.gx.slice();
    const sy = w.gy.slice();
    windToFace(asCube(grid), w.gx, w.gy);
    return { gx: w.gx, gy: w.gy, ex, sy };
  }
  return coarseWindFlatFrame(lat, grid, dirNoise, o);
}

function coarseWindFlatFrame(
  lat: Float32Array,
  grid: Grid,
  dirNoise: Float32Array,
  o: Omit<WindOptions, 'noise'> & { noiseRad: number },
): Wind {
  const { n, cellKm } = grid;
  let f = 1;
  while (f * 2 * cellKm <= 8 && n % (f * 2) === 0 && n / (f * 2) >= 16) f *= 2;
  const noise = f === 1 ? dirNoise : downsample(dirNoise, grid, f);
  for (let i = 0; i < noise.length; i++) noise[i] *= o.noiseRad;
  const c = windField(f === 1 ? lat : downsample(lat, grid, f), { shiftDeg: o.shiftDeg, noise, overrideDeg: o.overrideDeg, overrideStrength: o.overrideStrength });
  if (f === 1) return c;
  const cg = coarser(grid, f);
  const gx = new Float32Array(grid.cells);
  const gy = new Float32Array(grid.cells);
  upsample(c.gx, cg, f, gx);
  upsample(c.gy, cg, f, gy);
  return { gx, gy };
}

/**
 * Mean over the annual cycle of max(T + A·cos θ − c, 0), θ uniform: ((T − c)·θ0 + A·sin θ0) / π
 * with cos θ0 = (c − T) / A. Two of these give the Holdridge biotemperature clamp(·, 0, 30).
 */
function excess(t: number, a: number, c: number): number {
  if (a <= 1e-6) return Math.max(t - c, 0);
  const k = (c - t) / a;
  if (k >= 1) return 0;
  if (k <= -1) return t - c;
  const th = Math.acos(k);
  return ((t - c) * th + a * Math.sqrt(1 - k * k)) / Math.PI;
}
