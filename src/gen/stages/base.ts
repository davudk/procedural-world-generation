import { Noise2 } from '../../shared/noise';
import { Noise3, planarNoise, type SurfaceNoise } from '../../shared/noise3';
import type { Layer } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { angle, asCube, cellOfDir, unitPositions } from '../grid/cube';
import { signedDistance } from '../grid/distance';
import { cellIndex, cellX, cellY, edgeCells, forWindow, type Grid } from '../grid/grid';
import { areaQuantile, boxBlur, quantile, smoothstep } from '../grid/ops';
import { cellAt } from '../grid/sample';
import { upliftForPeak } from '../lem/streamPower';
import type { StageDef } from '../pipeline';
import { B, shapeHeader, type PlatesExtra, type Segment } from './plates';

/** Bedrock erodibility (research 01 §3.5), m^0.2/yr for m = 0.4. */
export const K0 = 1e-5;
export const LEM_M = 0.4;
/** Half spreading rate of mid-ocean ridges, km/Myr (for the √age depth profile). */
const RIDGE_HALF_RATE = 25;
/** Orogen uplift gain over the steady-state estimate (M8: the LEM never reaches steady state). */
const OROGEN_GAIN = 1.6;
/** Floor of the along-strike segmentation (0..1): higher = fewer low saddles along a range. */
const ALONG_FLOOR = 0.7;
/** Start of the gap smoothstep: lower = fewer stretches of a range belt switched off. */
const GAP_START = -0.75;
/** Exponent of the across-strike orogen profile (1 − t²)^p; 2 = the old `bump`. */
const BELT_POWER = 1;
/** Minimum convergence factor of a range's uplift (slow boundaries still build real ranges). */
const CONV_FLOOR = 0.8;
/** Plateau uplift behind a range, relative to the range's own uplift (Tibet, Altiplano). */
const PLATEAU_GAIN = 0.5;
/** Wanted share of continental crust inside range cores, and the most a belt may be widened for it. */
const BELT_TARGET_SHARE = 0.1;
const BELT_MAX_MUL = 2.2;
/** Intraplate swells: share of the noise field above the cut, wavelength (km) and target summit (m). */
const SWELL_SHARE = 0.32;
const SWELL_KM = 500;
const SWELL_PEAK = 4500;
/** Cap on uplift, relative to the steady-state uplift for the top of the peakHeight spread. */
const U_CAP_REL = 0.6;
/** King massif: summit target relative to the top of the peakHeight spread, and cone radius (km). */
const KING_REL = 1.7;
const KING_RADIUS_KM = 40;
/** Ceiling of the king's uplift target (m). Erosion-model summits land ~1.5× above it; the refine stage's summit ceiling keeps them below 9 km. */
const KING_MAX_M = 7000;
/**
 * Spheres: the first resolved cell of the uplift calibration (`upliftForPeak`'s s0) is capped at this
 * size. The calibration was fitted on 2–4 km erosion cells; on coarser cells (8 km in sphere previews,
 * 4–16 km on larger planets) the erosion model builds more relief than it predicts, so every range
 * reached the summit ceiling (p95 peak 7.8 km on the small planet against 5.1 km on a flat world). With
 * the cap the p95 peak, the share of land above 2 km and the king ratio match the flat defaults
 * (research 11 §3). Cells coarser than SPHERE_RELIEF_COARSE_M (previews of 8,192 km and larger planets)
 * overshoot further, so there s0 shrinks in proportion (s0 · cell = 2.5 km × 8 km). The king massif
 * keeps the true cell size: it is meant to stand at the ceiling. Flat worlds use their own cell size
 * (their goldens are unchanged).
 */
const SPHERE_RELIEF_CELL_M = 2500;
const SPHERE_RELIEF_COARSE_M = 8000;
/** Dome profile exponent (1 − (r/R)²)^p: higher = a sharper summit, but a lower one. */
const KING_SHAPE = 1;

export interface BaseExtra {
  n: number;
  cellKm: number;
  /** Initial elevation, metres relative to provisional sea level. */
  h0: Float32Array;
  /** Uplift, m/yr. */
  U: Float32Array;
  /** Erodibility. */
  K: Float32Array;
  /** Caprock layer thickness in metres (0 = no layered rock). */
  strata: Float32Array;
}

/** Per-segment range properties drawn from the spread ranges. */
interface SegProps {
  peak: number;
  halfWidthKm: number;
  plateau: boolean;
  /** Phase of the along-strike segmentation noise. */
  phase: number;
}

/**
 * S2 Base elevation: crust profile (shelf, slope, rise, abyss), boundary features (trenches, ridges,
 * rifts) into `h0`, and the uplift `U` and erodibility `K` maps that the erosion model turns into
 * mountains (research 01 §1.3–1.6, §3.6). Coastlines come from a warped signed distance to the
 * continents, not from plate polygons.
 */
export const baseStage: StageDef = {
  id: 'base',
  label: 'Base elevation',
  inputs: ['plates'],
  reads: [
    'worldSize', 'landFraction', 'lemGrid', 'coastRoughness', 'islandAbundance', 'peakHeight', 'rangeWidth', 'rangeLength',
    'plateauChance', 'geologicAge', 'strataShare', 'worldShape', 'faceGrid',
  ],
  async run(ctx) {
    const P = ctx.input('plates').extra as PlatesExtra;
    const sphere = ctx.str('worldShape') === 'sphere';
    // Sphere: the erosion grid has half the macro face size; previews 6 × 160² (6.4 km cells on the
    // default planet; 6 × 128² took 0.67× the time but under-resolved band R, Sphere polish in PLAN.md).
    const n = sphere ? (ctx.mode === 'preview' ? 160 : Number(ctx.str('faceGrid')) / 2) : ctx.mode === 'preview' ? 256 : Number(ctx.str('lemGrid'));
    const g = ctx.grid(n);
    const worldKm = ctx.num('worldSize');
    const cellKm = sphere ? g.cellKm : worldKm / n;
    const cellM = cellKm * 1000;
    // Spheres: uplift is calibrated as if the erosion cells were at most SPHERE_RELIEF_CELL_M (see there).
    const upM = sphere ? Math.min(cellM, SPHERE_RELIEF_CELL_M * Math.min(1, SPHERE_RELIEF_COARSE_M / cellM)) : cellM;
    const N = g.cells;
    const pg = ctx.grid(P.n);
    // Planar noise on flat maps (bit-identical to Noise2), 3D noise at the surface position on the sphere.
    const surfaceNoise = (seed: number): SurfaceNoise => (sphere ? new Noise3(seed) : planarNoise(new Noise2(seed)));
    const noise = surfaceNoise(ctx.rng('noise').nextU32());
    const warpN = surfaceNoise(ctx.rng('warp').nextU32());
    const coastN = surfaceNoise(ctx.rng('coast').nextU32());
    const segN = surfaceNoise(ctx.rng('segments').nextU32());
    // Surface position in km of every cell: map x / y (z = 0) on flat, unit vector × R on the sphere.
    const P3 = sphere ? unitPositions(asCube(g)) : null;
    const Rk = g.radiusM / 1000;
    const posKm = (i: number, out: Float64Array): void => {
      if (P3) {
        out[0] = P3[i * 3] * Rk;
        out[1] = P3[i * 3 + 1] * Rk;
        out[2] = P3[i * 3 + 2] * Rk;
      } else {
        out[0] = (cellX(g, i) + 0.5) * cellKm;
        out[1] = (cellY(g, i) + 0.5) * cellKm;
        out[2] = 0;
      }
    };
    const w3 = new Float64Array(3);

    // Warped lookup into the plate grid, so coasts and ranges don't trace the coarse grid.
    const pcell = new Int32Array(N);
    const wxs = new Float32Array(N);
    const wys = new Float32Array(N);
    const wzs = sphere ? new Float32Array(N) : wxs;
    const cont = new Uint8Array(N);
    if (sphere) {
      const pc3 = asCube(pg);
      for (let i = 0; i < N; i++) {
        posKm(i, w3);
        const [wx, wy, wz] = w3;
        const qx = wx + 30 * warpN.fbm3(wx / 220, wy / 220, wz / 220, 3);
        const qy = wy + 30 * warpN.fbm3(wx / 220 + 19.1, wy / 220 - 7.3, wz / 220 + 4.2, 3);
        const qz = wz + 30 * warpN.fbm3(wx / 220 - 11.7, wy / 220 + 5.5, wz / 220 - 9.9, 3);
        wxs[i] = qx;
        wys[i] = qy;
        wzs[i] = qz;
        const pc = cellOfDir(pc3, qx, qy, qz);
        pcell[i] = pc;
        cont[i] = P.continent[pc] !== -1 ? 1 : 0;
      }
    } else {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = cellIndex(g, x, y);
          const wx = (x + 0.5) * cellKm;
          const wy = (y + 0.5) * cellKm;
          const qx = wx + 30 * warpN.fbm3(wx / 220, wy / 220, 0, 3);
          const qy = wy + 30 * warpN.fbm3(wx / 220 + 19.1, wy / 220 - 7.3, 0, 3);
          wxs[i] = qx;
          wys[i] = qy;
          const pc = cellAt(pg, qx / worldKm, qy / worldKm);
          pcell[i] = pc;
          cont[i] = P.continent[pc] !== -1 ? 1 : 0;
        }
      }
    }
    await ctx.checkpoint();

    const sdf = signedDistance(cont, g);
    const segs = P.segments.map((s, id) => segProps(ctx.rng('segment', id), s, ctx));
    // Direct steering of relief contrast (research 05 §3.6, CONFIG.md §4): when the range cores cover
    // too little of the continental crust (few or short convergent boundaries), widen every belt.
    const beltShare = beltCoreShare(P, segs);
    const beltMul = Math.min(BELT_MAX_MUL, Math.max(1, BELT_TARGET_SHARE / Math.max(beltShare, 1e-3)));
    for (const sp of segs) sp.halfWidthKm *= beltMul;
    const rangeLen = ctx.range('rangeLength');
    const segWavelength = Math.max(40, (rangeLen[0] + rangeLen[1]) / 2 / 2.5);
    const gain = Math.min(0.68, Math.max(0.38, 0.5 + (ctx.num('coastRoughness') - 1.25) * 1.2));
    const islands = ctx.num('islandAbundance');
    const age = ctx.num('geologicAge');
    const strataShare = ctx.num('strataShare');
    const strataCut = quantileOfNoise(ctx.rng('strata-q'), 1 - strataShare, sphere);

    const h0 = new Float32Array(N);
    const U = new Float32Array(N);
    const K = new Float32Array(N);
    const strata = new Float32Array(N);
    const deep = new Float32Array(N);
    const coastA = new Float32Array(N);
    const uOro = new Float32Array(N);
    const uBg = upliftForPeak(400 + 900 * (1 - age), K0, LEM_M, 30_000, upM);

    const PB = sphere ? unitPositions(asCube(pg)) : null;
    const q3 = new Float64Array(3);
    for (let i = 0; i < N; i++) {
      {
        posKm(i, w3);
        const wx = w3[0];
        const wy = w3[1];
        const wz = w3[2];
        // Coast field (km, + inland): warped distance + fractal noise + ridged peninsulas near the coast.
        const s = sdf[i] * cellKm;
        const near = 1 - smoothstep(60, 180, Math.abs(s));
        const coast =
          s +
          45 * coastN.fbm3(wx / 200 + 0.6 * coastN.fbm3(wx / 500, wy / 500, wz / 500, 2), wy / 200, wz / 200, 6, 2, gain) +
          55 * near * islands * (coastN.ridged3(wx / 260 + 31, wy / 260 - 11, wz / 260 + 7, 3) - 0.45);

        // Nearest plate boundary (sphere: great-circle distance from the warped point).
        const pc = pcell[i];
        const nb = P.nearest[pc];
        let dB: number;
        if (PB) {
          q3[0] = wxs[i];
          q3[1] = wys[i];
          q3[2] = wzs[i];
          dB = Rk * angle(q3, PB.subarray(nb * 3, nb * 3 + 3));
        } else {
          const bx = (cellX(pg, nb) + 0.5) * P.cellKm;
          const by = (cellY(pg, nb) + 0.5) * P.cellKm;
          dB = Math.hypot(wxs[i] - bx, wys[i] - by);
        }
        const cls = P.bClass[nb];
        const segId = P.bSeg[nb];
        const seg = segId >= 0 ? P.segments[segId] : null;
        const sp = segId >= 0 ? segs[segId] : null;
        const ownPlate = P.plate[pc];
        const ownCont = cont[i] === 1;
        const activeMargin = seg !== null && dB < 400 && (cls === B.SUBDUCTION || cls === B.ARC || cls === B.COLLISION);

        let h = coast >= 0 ? landBase(coast, noise, wx, wy, wz) : oceanProfile(-coast, activeMargin ? 25 : 75, noise, wx, wy, wz);
        // Background hills are patchy: about a third of the land stays as quiet lowland plains.
        const hilly = 0.25 + 0.75 * smoothstep(-0.15, 0.25, noise.fbm3(wx / 420 + 13, wy / 420 - 5, wz / 420 + 3, 3));
        let u = coast >= 0 ? uBg * hilly * (0.4 + 0.6 * (0.5 + 0.5 * noise.fbm3(wx / 120, wy / 120, wz / 120, 3))) : 0;
        const uBack = u;
        let lith = 1;

        if (seg && sp) {
          const along =
            ALONG_FLOOR + (1 - ALONG_FLOOR) * segN.ridged3(wx / segWavelength + sp.phase, wy / segWavelength - sp.phase, wz / segWavelength + 0.5 * sp.phase, 3);
          const gap = smoothstep(GAP_START, -0.15, segN.fbm3(wx / (segWavelength * 2) - sp.phase, wy / (segWavelength * 2), wz / (segWavelength * 2) + sp.phase, 2));
          const convK = Math.min(1.3, Math.max(CONV_FLOOR, Math.abs(seg.conv) / 40));
          const U0 = OROGEN_GAIN * upliftForPeak(sp.peak, K0, LEM_M, sp.halfWidthKm * 1000, upM) * convK * along * gap;
          const w = sp.halfWidthKm;
          switch (cls) {
            case B.COLLISION:
              u += U0 * belt(dB, w);
              if (sp.plateau && seg.overriding === ownPlate) u += PLATEAU_GAIN * U0 * plateau(dB, w, 260);
              break;
            case B.SUBDUCTION:
              if (ownCont) {
                u += U0 * belt(dB - 0.7 * w, w * 0.8);
                // Altiplano: a high plateau behind the cordillera on the continental side.
                if (sp.plateau) u += PLATEAU_GAIN * U0 * plateau(dB - 0.7 * w, 0.8 * w, 200);
              }
              else h -= 3500 * Math.exp(-((dB / 35) ** 2));
              break;
            case B.ARC:
              if (seg.overriding === ownPlate) h = Math.max(h, -1800 + 1300 * islands * bump(dB - 130, 55));
              else h -= 3200 * Math.exp(-((dB / 35) ** 2));
              break;
            case B.RIFT:
              // Graben: segmented along strike with soft walls, so drowned rifts don't read as boxes.
              h -= 1100 * gap * along * (1 - smoothstep(10, 50 + 20 * along, dB));
              u += 0.25 * U0 * bump(dB - 55, 30);
              break;
            case B.RIDGE:
              if (!ownCont && coast < -150) {
                h = Math.max(h, -(2500 + 350 * Math.sqrt(dB / RIDGE_HALF_RATE)));
              }
              break;
            case B.TRANSFORM:
              if (dB < 6) lith *= 3;
              break;
          }
        }

        // Lithology: provinces, old cratons, hard intrusions (inselbergs), layered rock.
        lith *= Math.exp(0.45 * noise.fbm3(wx / 300 + 51, wy / 300 - 23, wz / 300 + 17, 3));
        if (coast > 0 && dB > 450) lith *= 0.6;
        const hard = noise.ridged3(wx / 45 - 77, wy / 45 + 13, wz / 45 - 31, 2);
        if (hard > 0.93 - 0.05 * age) lith *= 0.15;
        if (noise.fbm3(wx / 350 - 140, wy / 350 + 90, wz / 350 + 60, 3) > strataCut && coast > 30) {
          strata[i] = 120 + 120 * (0.5 + 0.5 * noise.fbm3(wx / 90, wy / 90, wz / 90, 2));
        }

        h0[i] = h;
        coastA[i] = coast;
        uOro[i] = u - uBack;
        deep[i] = smoothstep(-25, -90, coast);
        U[i] = u;
        K[i] = K0 * lith;
      }
      if ((i & 16383) === 16383) await ctx.checkpoint();
    }

    // Intraplate swells (Colorado / East African / Iranian plateaus): broad highlands that need no
    // convergent boundary, so worlds with weak or mostly offshore orogens still get high ground
    // (research 05 §3.6). A land-only quantile places them on a fixed share of the inland crust.
    const uSwell = OROGEN_GAIN * upliftForPeak(SWELL_PEAK * Math.max(0, 1.3 - age), K0, LEM_M, 40_000, upM);
    // Island worlds have little continental interior: swells shrink with the land fraction.
    const swellShare = SWELL_SHARE * Math.min(1, ctx.num('landFraction') / 0.22);
    if (swellShare > 0 && uSwell > 0) {
      const sv = new Float32Array(N).fill(-Infinity);
      const inland: number[] = [];
      for (let i = 0; i < N; i++) {
        if (coastA[i] <= 30) continue;
        posKm(i, w3);
        sv[i] = noise.fbm3(w3[0] / SWELL_KM + 211, w3[1] / SWELL_KM - 97, w3[2] / SWELL_KM + 41, 3);
        if (coastA[i] > 150) inland.push(sv[i]);
      }
      // Small worlds may have no land far enough inland: then there are no swells (and no NaN cut).
      const cut = inland.length ? quantile(Float32Array.from(inland), 1 - swellShare) : Infinity;
      for (let i = 0; Number.isFinite(cut) && i < N; i++) {
        if (sv[i] === -Infinity) continue;
        const sw = smoothstep(cut - 0.1, cut + 0.1, sv[i]);
        if (!(sw > 0)) continue;
        posKm(i, w3);
        const k = sw * smoothstep(30, 150, coastA[i]) * (0.75 + 0.25 * noise.fbm3(w3[0] / 90 - 3, w3[1] / 90 + 8, w3[2] / 90 - 5, 2));
        U[i] += uSwell * k;
      }
    }

    // Summit cap: overlapping belts, plateaus and swells must not stack into 10 km peaks; ranges top
    // out near the top of the peakHeight spread (the king massif is the one exception).
    const uCap = U_CAP_REL * upliftForPeak(ctx.range('peakHeight')[1], K0, LEM_M, 40_000, upM);
    for (let i = 0; i < N; i++) if (U[i] > uCap) U[i] = uCap;
    // Deep-ocean features come from per-segment boundary profiles; smooth them so the abyss has no facets.
    const blurred = h0.slice();
    boxBlur(blurred, g, Math.max(1, Math.round(18 / cellKm)), 2);
    for (let i = 0; i < N; i++) h0[i] += (blurred[i] - h0[i]) * deep[i];
    // Uplift ends abruptly where a boundary segment ends; a blur tapers range ends naturally.
    boxBlur(U, g, Math.max(1, Math.round(10 / cellKm)), 2);

    // Area-weighted on the sphere (cells differ by up to √2 in area); plain quantile on flat maps.
    const sea = areaQuantile(h0, g, 1 - ctx.num('landFraction'));
    // King massif (research 05 §3.6: highest summit ≥ 1.5 × the 95th-percentile peak): one uplift
    // cone with a uniform crystalline core, preferably on the strongest orogen well inland, standing
    // clear above every other range. Placed after sea level is known, so the whole cone is on land.
    const king = placeKing(g, h0, U, uOro, coastA, sea);
    if (king) {
      const rCells = king.rKm / cellKm;
      const r0 = Math.ceil(rCells);
      const uKing = OROGEN_GAIN * upliftForPeak(Math.min(KING_MAX_M, KING_REL * ctx.range('peakHeight')[1]), K0, LEM_M, king.rKm * 1000, cellM);
      const cone = (i: number, t: number): void => {
        if (t >= 1) return;
        U[i] = Math.max(U[i], uKing * (1 - t * t) ** KING_SHAPE);
        K[i] = K0;
        strata[i] = 0;
      };
      if (sphere) g.chart(g.point(king.c), king.rKm * 1000, (i, e, nn) => cone(i, Math.hypot(e, nn) / (king.rKm * 1000)));
      else forWindow(g, king.c, r0, (i, dx, dy) => cone(i, Math.hypot(dx, dy) / rCells));
    }
    let lo = Infinity;
    let hi = -Infinity;
    let uMax = 0;
    for (let i = 0; i < N; i++) {
      h0[i] -= sea;
      lo = Math.min(lo, h0[i]);
      hi = Math.max(hi, h0[i]);
      uMax = Math.max(uMax, U[i]);
    }
    const Umm = new Float32Array(N);
    for (let i = 0; i < N; i++) Umm[i] = U[i] * 1000;
    const Klog = new Float32Array(N);
    for (let i = 0; i < N; i++) Klog[i] = Math.log10(K[i]);

    const sh = shapeHeader(g);
    const layers: Layer[] = [
      { id: 'h0', label: 'Initial elevation', stage: 'base', kind: 'elevation', w: n, h: n, worldKm, ...sh, unit: 'm', min: lo, max: hi, data: h0 },
      { id: 'uplift', label: 'Uplift', stage: 'base', kind: 'scalar', w: n, h: n, worldKm, ...sh, unit: 'mm/yr', min: 0, max: uMax * 1000, data: Umm },
      { id: 'erodibility', label: 'Erodibility (log10 K)', stage: 'base', kind: 'scalar', w: n, h: n, worldKm, ...sh, unit: '', min: -6.5, max: -4.3, data: Klog },
    ];
    const extra: BaseExtra = { n, cellKm, h0, U, K, strata };
    return { layers, stats: { maxUpliftMmYr: uMax * 1000, seaLevelShift: sea, beltShare, beltMul, kingRadiusKm: king ? king.rKm : 0, kingCell: king ? king.c : -1 }, outcomes: {}, extra };
  },
};

function segProps(rng: Rng, s: Segment, ctx: { range(id: string): readonly [number, number]; num(id: string): number }): SegProps {
  const [p0, p1] = ctx.range('peakHeight');
  const [w0, w1] = ctx.range('rangeWidth');
  // Collisions build the highest ranges; cordilleras sit lower on average.
  const t = s.cls === B.COLLISION ? rng.range(0.35, 1) : rng.range(0, 0.8);
  return {
    peak: p0 + (p1 - p0) * t,
    halfWidthKm: rng.range(w0, w1) / 2,
    plateau: rng.float() < ctx.num('plateauChance'),
    phase: rng.range(0, 100),
  };
}

/** Land base: low plains rising gently inland, with rolling noise. */
function landBase(s: number, noise: SurfaceNoise, wx: number, wy: number, wz: number): number {
  // The last term is small-scale roughness: on low-uplift plains the erosion model otherwise routes
  // water over a near-planar surface and D8 cuts straight, parallel, axis-aligned channels.
  return (
    120 + 380 * smoothstep(0, 320, s) + 220 * noise.fbm3(wx / 160, wy / 160, wz / 160, 4) +
    35 * noise.fbm3(wx / 14 + 71, wy / 14 - 29, wz / 14 + 13, 3)
  );
}

/** Ocean profile by distance from the coast (research 01 §1.4). */
function oceanProfile(d: number, shelfKm: number, noise: SurfaceNoise, wx: number, wy: number, wz: number): number {
  let h: number;
  if (d < shelfKm) h = -130 * (d / shelfKm) ** 0.7;
  else if (d < shelfKm + 60) h = -130 - 2870 * smoothstep(0, 1, (d - shelfKm) / 60);
  else if (d < shelfKm + 260) h = -3000 - 1500 * ((d - shelfKm - 60) / 200);
  else h = -4500 - 500 * (0.5 + 0.5 * noise.fbm3(wx / 400, wy / 400, wz / 400, 2));
  return h + 120 * noise.fbm3(wx / 35, wy / 35, wz / 35, 3) * smoothstep(shelfKm, shelfKm + 100, d);
}

/** Smooth compact bump: 1 at x = 0, 0 beyond |x| ≥ w. */
function bump(x: number, w: number): number {
  const t = x / w;
  return t >= 1 || t <= -1 ? 0 : (1 - t * t) ** 2;
}

/**
 * Site of the king massif: the land cell with the strongest uplift (orogens preferred, far inland
 * slightly preferred) whose whole cone of radius r stands on land; r shrinks for small landmasses.
 */
function placeKing(
  g: Grid, h0: Float32Array, U: Float32Array, uOro: Float32Array, coastA: Float32Array, sea: number,
): { c: number; rKm: number } | null {
  const { cells: N, cellKm } = g;
  for (const f of [1, 0.7, 0.5]) {
    const rKm = KING_RADIUS_KM * f;
    const rCells = rKm / cellKm;
    const r0 = Math.ceil(rCells);
    const score = (i: number): number => U[i] * (uOro[i] > 0 ? 1.25 : 1) * (1 + 0.15 * smoothstep(rKm, 400, coastA[i]));
    let cands: number[] = [];
    for (let i = 0; i < N; i++) if (h0[i] > sea && coastA[i] >= 0.8 * rKm) cands.push(i);
    if (cands.length > 4000) {
      // Only the strongest few thousand matter; trim before sorting (build grids have ~10⁶ cells).
      const cut = quantile(Float32Array.from(cands, score), 1 - 4000 / cands.length);
      cands = cands.filter((i) => score(i) >= cut);
    }
    cands.sort((a, b) => score(b) - score(a) || a - b);
    for (const c of cands.slice(0, 400)) {
      // The whole cone must fit on the map and stand on land.
      let dry = edgeCells(g, c) >= r0;
      if (dry && g.shape === 'sphere') {
        g.chart(g.point(c), rKm * 1000, (j, e, nn) => {
          if (Math.hypot(e, nn) < rKm * 1000 && h0[j] <= sea + 50) dry = false;
        });
      } else if (dry) {
        forWindow(g, c, r0, (j, dx, dy) => {
          if (Math.hypot(dx, dy) < rCells && h0[j] <= sea + 50) dry = false;
          return dry;
        });
      }
      if (dry) return { c, rKm };
    }
  }
  return null;
}

/** Share of continental plate-grid cells inside the core of a collision or cordillera belt. */
function beltCoreShare(P: PlatesExtra, segs: readonly SegProps[]): number {
  let cont = 0;
  let core = 0;
  for (let c = 0; c < P.continent.length; c++) {
    if (P.continent[c] === -1) continue;
    cont++;
    const id = P.bSeg[P.nearest[c]];
    if (id < 0) continue;
    const cls = P.segments[id].cls;
    const d = P.dBKm[c];
    const w = segs[id].halfWidthKm;
    if (cls === B.COLLISION ? d < 0.6 * w : cls === B.SUBDUCTION && Math.abs(d - 0.7 * w) < 0.5 * w) core++;
  }
  return core / Math.max(1, cont);
}

/** Orogen belt across strike: flatter-topped than `bump`, so more of the belt stands high. */
function belt(x: number, w: number): number {
  const t = x / w;
  return t >= 1 || t <= -1 ? 0 : (1 - t * t) ** BELT_POWER;
}

/** Plateau behind a range: rises after the range half-width and fades over `len` km. */
function plateau(dB: number, w: number, len: number): number {
  return smoothstep(0.5 * w, w, dB) * (1 - smoothstep(w + len * 0.6, w + len, dB));
}

/** fBm value below which a fraction `q` of samples fall (estimated from random samples of 2D or 3D noise). */
function quantileOfNoise(rng: Rng, q: number, sphere: boolean): number {
  if (q >= 1) return Infinity;
  if (q <= 0) return -Infinity;
  if (sphere) {
    const nz = new Noise3(rng.nextU32());
    return quantile(Float32Array.from({ length: 2048 }, () => nz.fbm3(rng.range(0, 64), rng.range(0, 64), rng.range(0, 64), 3)), q);
  }
  const nz = new Noise2(rng.nextU32());
  const s = Float32Array.from({ length: 2048 }, () => nz.fbm(rng.range(0, 64), rng.range(0, 64), 3));
  return quantile(s, q);
}
