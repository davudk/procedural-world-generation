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
    const uBg = upliftForPeak(250 + 700 * (1 - age), K0, LEM_M, 30_000, cellM);

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
        const hilly = 0.12 + 0.88 * smoothstep(-0.15, 0.25, noise.fbm(wx / 420 + 13, wy / 420 - 5, 3));
        let u = coast >= 0 ? uBg * hilly * (0.4 + 0.6 * (0.5 + 0.5 * noise.fbm(wx / 120, wy / 120, 3))) : 0;
        let lith = 1;

        if (seg && sp) {
          const along = 0.55 + 0.45 * segN.ridged(wx / segWavelength + sp.phase, wy / segWavelength - sp.phase, 3);
          const gap = smoothstep(-0.55, -0.15, segN.fbm(wx / (segWavelength * 2) - sp.phase, wy / (segWavelength * 2), 2));
          const convK = Math.min(1.3, Math.max(0.5, Math.abs(seg.conv) / 40));
          const U0 = upliftForPeak(sp.peak, K0, LEM_M, sp.halfWidthKm * 1000, cellM) * convK * along * gap;
          const w = sp.halfWidthKm;
          switch (cls) {
            case B.COLLISION:
              u += U0 * bump(dB, w);
              if (sp.plateau && seg.overriding === ownPlate) u += 0.35 * U0 * plateau(dB, w, 260);
              break;
            case B.SUBDUCTION:
              if (ownCont) u += U0 * bump(dB - 0.7 * w, w * 0.8);
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
        deep[i] = smoothstep(-25, -90, coast);
        U[i] = u;
        K[i] = K0 * lith;
      }
      if ((y & 31) === 0) await ctx.checkpoint();
    }

    // Deep-ocean features come from per-segment boundary profiles; smooth them so the abyss has no facets.
    const blurred = h0.slice();
    boxBlur(blurred, n, Math.max(1, Math.round(18 / cellKm)), 2);
    for (let i = 0; i < N; i++) h0[i] += (blurred[i] - h0[i]) * deep[i];
    // Uplift ends abruptly where a boundary segment ends; a blur tapers range ends naturally.
    boxBlur(U, n, Math.max(1, Math.round(10 / cellKm)), 2);

    const sea = quantile(h0, 1 - ctx.num('landFraction'));
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
    return { layers, stats: { maxUpliftMmYr: uMax * 1000, seaLevelShift: sea }, outcomes: {}, extra };
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
