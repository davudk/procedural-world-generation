import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { signedDistance } from '../grid/distance';
import { boxBlur, quantile, smoothstep } from '../grid/ops';
import { cellAt } from '../grid/sample';
import { upliftForPeak } from '../lem/streamPower';
import type { StageDef } from '../pipeline';
import { B, type PlatesExtra, type Segment } from './plates';

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
const U_CAP_REL = 0.68;
/** King massif: summit target relative to the top of the peakHeight spread, and cone radius (km). */
const KING_REL = 1.7;
const KING_RADIUS_KM = 40;
/** Ceiling of the king's uplift target (m); erosion-model summits land ~1.25× above the target. */
const KING_MAX_M = 8000;
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
    'plateauChance', 'geologicAge', 'strataShare',
  ],
  async run(ctx) {
    const P = ctx.input('plates').extra as PlatesExtra;
    const n = ctx.mode === 'preview' ? 256 : Number(ctx.str('lemGrid'));
    const worldKm = ctx.num('worldSize');
    const cellKm = worldKm / n;
    const cellM = cellKm * 1000;
    const N = n * n;
    const noise = new Noise2(ctx.rng('noise').nextU32());
    const warpN = new Noise2(ctx.rng('warp').nextU32());
    const coastN = new Noise2(ctx.rng('coast').nextU32());
    const segN = new Noise2(ctx.rng('segments').nextU32());

    // Warped lookup into the plate grid, so coasts and ranges don't trace the coarse grid.
    const pcell = new Int32Array(N);
    const wxs = new Float32Array(N);
    const wys = new Float32Array(N);
    const cont = new Uint8Array(N);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const wx = (x + 0.5) * cellKm;
        const wy = (y + 0.5) * cellKm;
        const qx = wx + 30 * warpN.fbm(wx / 220, wy / 220, 3);
        const qy = wy + 30 * warpN.fbm(wx / 220 + 19.1, wy / 220 - 7.3, 3);
        wxs[i] = qx;
        wys[i] = qy;
        const pc = cellAt(P.n, qx / worldKm, qy / worldKm);
        pcell[i] = pc;
        cont[i] = P.continent[pc] !== -1 ? 1 : 0;
      }
    }
    await ctx.checkpoint();

    const sdf = signedDistance(cont, n);
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
    const strataCut = quantileOfNoise(ctx.rng('strata-q'), 1 - strataShare);

    const h0 = new Float32Array(N);
    const U = new Float32Array(N);
    const K = new Float32Array(N);
    const strata = new Float32Array(N);
    const deep = new Float32Array(N);
    const coastA = new Float32Array(N);
    const uOro = new Float32Array(N);
    const uBg = upliftForPeak(400 + 900 * (1 - age), K0, LEM_M, 30_000, cellM);

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const wx = (x + 0.5) * cellKm;
        const wy = (y + 0.5) * cellKm;
        // Coast field (km, + inland): warped distance + fractal noise + ridged peninsulas near the coast.
        const s = sdf[i] * cellKm;
        const near = 1 - smoothstep(60, 180, Math.abs(s));
        const coast =
          s +
          45 * coastN.fbm(wx / 200 + 0.6 * coastN.fbm(wx / 500, wy / 500, 2), wy / 200, 6, 2, gain) +
          55 * near * islands * (coastN.ridged(wx / 260 + 31, wy / 260 - 11, 3) - 0.45);

        // Nearest plate boundary.
        const pc = pcell[i];
        const nb = P.nearest[pc];
        const bx = ((nb % P.n) + 0.5) * P.cellKm;
        const by = (Math.floor(nb / P.n) + 0.5) * P.cellKm;
        const dB = Math.hypot(wxs[i] - bx, wys[i] - by);
        const cls = P.bClass[nb];
        const segId = P.bSeg[nb];
        const seg = segId >= 0 ? P.segments[segId] : null;
        const sp = segId >= 0 ? segs[segId] : null;
        const ownPlate = P.plate[pc];
        const ownCont = cont[i] === 1;
        const activeMargin = seg !== null && dB < 400 && (cls === B.SUBDUCTION || cls === B.ARC || cls === B.COLLISION);

        let h = coast >= 0 ? landBase(coast, noise, wx, wy) : oceanProfile(-coast, activeMargin ? 25 : 75, noise, wx, wy);
        // Background hills are patchy: about a third of the land stays as quiet lowland plains.
        const hilly = 0.25 + 0.75 * smoothstep(-0.15, 0.25, noise.fbm(wx / 420 + 13, wy / 420 - 5, 3));
        let u = coast >= 0 ? uBg * hilly * (0.4 + 0.6 * (0.5 + 0.5 * noise.fbm(wx / 120, wy / 120, 3))) : 0;
        const uBack = u;
        let lith = 1;

        if (seg && sp) {
          const along = ALONG_FLOOR + (1 - ALONG_FLOOR) * segN.ridged(wx / segWavelength + sp.phase, wy / segWavelength - sp.phase, 3);
          const gap = smoothstep(GAP_START, -0.15, segN.fbm(wx / (segWavelength * 2) - sp.phase, wy / (segWavelength * 2), 2));
          const convK = Math.min(1.3, Math.max(CONV_FLOOR, Math.abs(seg.conv) / 40));
          const U0 = OROGEN_GAIN * upliftForPeak(sp.peak, K0, LEM_M, sp.halfWidthKm * 1000, cellM) * convK * along * gap;
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
        lith *= Math.exp(0.45 * noise.fbm(wx / 300 + 51, wy / 300 - 23, 3));
        if (coast > 0 && dB > 450) lith *= 0.6;
        const hard = noise.ridged(wx / 45 - 77, wy / 45 + 13, 2);
        if (hard > 0.93 - 0.05 * age) lith *= 0.15;
        if (noise.fbm(wx / 350 - 140, wy / 350 + 90, 3) > strataCut && coast > 30) strata[i] = 120 + 120 * (0.5 + 0.5 * noise.fbm(wx / 90, wy / 90, 2));

        h0[i] = h;
        coastA[i] = coast;
        uOro[i] = u - uBack;
        deep[i] = smoothstep(-25, -90, coast);
        U[i] = u;
        K[i] = K0 * lith;
      }
      if ((y & 31) === 0) await ctx.checkpoint();
    }

    // Intraplate swells (Colorado / East African / Iranian plateaus): broad highlands that need no
    // convergent boundary, so worlds with weak or mostly offshore orogens still get high ground
    // (research 05 §3.6). A land-only quantile places them on a fixed share of the inland crust.
    const uSwell = OROGEN_GAIN * upliftForPeak(SWELL_PEAK * Math.max(0, 1.3 - age), K0, LEM_M, 40_000, cellM);
    // Island worlds have little continental interior: swells shrink with the land fraction.
    const swellShare = SWELL_SHARE * Math.min(1, ctx.num('landFraction') / 0.22);
    if (swellShare > 0 && uSwell > 0) {
      const sv = new Float32Array(N).fill(-Infinity);
      const inland: number[] = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          if (coastA[i] <= 30) continue;
          sv[i] = noise.fbm(((x + 0.5) * cellKm) / SWELL_KM + 211, ((y + 0.5) * cellKm) / SWELL_KM - 97, 3);
          if (coastA[i] > 150) inland.push(sv[i]);
        }
      }
      // Small worlds may have no land far enough inland: then there are no swells (and no NaN cut).
      const cut = inland.length ? quantile(Float32Array.from(inland), 1 - swellShare) : Infinity;
      for (let i = 0; Number.isFinite(cut) && i < N; i++) {
        if (sv[i] === -Infinity) continue;
        const sw = smoothstep(cut - 0.1, cut + 0.1, sv[i]);
        if (!(sw > 0)) continue;
        const k = sw * smoothstep(30, 150, coastA[i]) * (0.75 + 0.25 * noise.fbm(((i % n) + 0.5) * cellKm / 90 - 3, (Math.floor(i / n) + 0.5) * cellKm / 90 + 8, 2));
        U[i] += uSwell * k;
      }
    }

    // Summit cap: overlapping belts, plateaus and swells must not stack into 10 km peaks; ranges top
    // out near the top of the peakHeight spread (the king massif is the one exception).
    const uCap = U_CAP_REL * upliftForPeak(ctx.range('peakHeight')[1], K0, LEM_M, 40_000, cellM);
    for (let i = 0; i < N; i++) if (U[i] > uCap) U[i] = uCap;
    // Deep-ocean features come from per-segment boundary profiles; smooth them so the abyss has no facets.
    const blurred = h0.slice();
    boxBlur(blurred, n, Math.max(1, Math.round(18 / cellKm)), 2);
    for (let i = 0; i < N; i++) h0[i] += (blurred[i] - h0[i]) * deep[i];
    // Uplift ends abruptly where a boundary segment ends; a blur tapers range ends naturally.
    boxBlur(U, n, Math.max(1, Math.round(10 / cellKm)), 2);

    const sea = quantile(h0, 1 - ctx.num('landFraction'));
    // King massif (research 05 §3.6: highest summit ≥ 1.5 × the 95th-percentile peak): one uplift
    // cone with a uniform crystalline core, preferably on the strongest orogen well inland, standing
    // clear above every other range. Placed after sea level is known, so the whole cone is on land.
    const king = placeKing(n, cellKm, h0, U, uOro, coastA, sea);
    if (king) {
      const rCells = king.rKm / cellKm;
      const r0 = Math.ceil(rCells);
      const uKing = OROGEN_GAIN * upliftForPeak(Math.min(KING_MAX_M, KING_REL * ctx.range('peakHeight')[1]), K0, LEM_M, king.rKm * 1000, cellM);
      for (let y = king.y - r0; y <= king.y + r0; y++) {
        for (let x = king.x - r0; x <= king.x + r0; x++) {
          const t = Math.hypot(x - king.x, y - king.y) / rCells;
          if (t >= 1) continue;
          const i = y * n + x;
          U[i] = Math.max(U[i], uKing * (1 - t * t) ** KING_SHAPE);
          K[i] = K0;
          strata[i] = 0;
        }
      }
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

    const layers: Layer[] = [
      { id: 'h0', label: 'Initial elevation', stage: 'base', kind: 'elevation', w: n, h: n, worldKm, unit: 'm', min: lo, max: hi, data: h0 },
      { id: 'uplift', label: 'Uplift', stage: 'base', kind: 'scalar', w: n, h: n, worldKm, unit: 'mm/yr', min: 0, max: uMax * 1000, data: Umm },
      { id: 'erodibility', label: 'Erodibility (log10 K)', stage: 'base', kind: 'scalar', w: n, h: n, worldKm, unit: '', min: -6.5, max: -4.3, data: Klog },
    ];
    const extra: BaseExtra = { n, cellKm, h0, U, K, strata };
    return { layers, stats: { maxUpliftMmYr: uMax * 1000, seaLevelShift: sea, beltShare, beltMul, kingRadiusKm: king ? king.rKm : 0, kingCell: king ? king.y * n + king.x : -1 }, outcomes: {}, extra };
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
function landBase(s: number, noise: Noise2, wx: number, wy: number): number {
  // The last term is small-scale roughness: on low-uplift plains the erosion model otherwise routes
  // water over a near-planar surface and D8 cuts straight, parallel, axis-aligned channels.
  return 120 + 380 * smoothstep(0, 320, s) + 220 * noise.fbm(wx / 160, wy / 160, 4) + 35 * noise.fbm(wx / 14 + 71, wy / 14 - 29, 3);
}

/** Ocean profile by distance from the coast (research 01 §1.4). */
function oceanProfile(d: number, shelfKm: number, noise: Noise2, wx: number, wy: number): number {
  let h: number;
  if (d < shelfKm) h = -130 * (d / shelfKm) ** 0.7;
  else if (d < shelfKm + 60) h = -130 - 2870 * smoothstep(0, 1, (d - shelfKm) / 60);
  else if (d < shelfKm + 260) h = -3000 - 1500 * ((d - shelfKm - 60) / 200);
  else h = -4500 - 500 * (0.5 + 0.5 * noise.fbm(wx / 400, wy / 400, 2));
  return h + 120 * noise.fbm(wx / 35, wy / 35, 3) * smoothstep(shelfKm, shelfKm + 100, d);
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
  n: number, cellKm: number, h0: Float32Array, U: Float32Array, uOro: Float32Array, coastA: Float32Array, sea: number,
): { x: number; y: number; rKm: number } | null {
  const N = n * n;
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
      const kx = c % n;
      const ky = (c - kx) / n;
      let dry = kx >= r0 && ky >= r0 && kx < n - r0 && ky < n - r0;
      for (let y = ky - r0; y <= ky + r0 && dry; y++) {
        for (let x = kx - r0; x <= kx + r0; x++) {
          if (Math.hypot(x - kx, y - ky) < rCells && h0[y * n + x] <= sea + 50) {
            dry = false;
            break;
          }
        }
      }
      if (dry) return { x: kx, y: ky, rKm };
    }
  }
  return null;
}

/** Share of continental plate-grid cells inside the core of a collision or cordillera belt. */
function beltCoreShare(P: PlatesExtra, segs: readonly SegProps[]): number {
  let cont = 0;
  let core = 0;
  for (let c = 0; c < P.n * P.n; c++) {
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

/** fBm value below which a fraction `q` of samples fall (estimated from random samples). */
function quantileOfNoise(rng: Rng, q: number): number {
  if (q >= 1) return Infinity;
  if (q <= 0) return -Infinity;
  const nz = new Noise2(rng.nextU32());
  const s = Float32Array.from({ length: 2048 }, () => nz.fbm(rng.range(0, 64), rng.range(0, 64), 3));
  return quantile(s, q);
}
