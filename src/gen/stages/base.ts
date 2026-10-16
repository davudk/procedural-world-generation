import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import { boxBlur, components, quantile, smoothstep } from '../grid/ops';
import type { StageDef } from '../pipeline';
import type { PlatesExtra } from './plates';

/** Land components at least this share of all land count as continents; smaller ones are islands. */
const CONTINENT_MIN_SHARE = 0.05;

/**
 * S2 Base elevation — M0 placeholder (M1 replaces it with crust profiles, boundary features and the
 * uplift/erodibility maps that feed the erosion model). Smoothed continental crust plus domain-warped
 * fBm, an ocean border, and sea level at the land-fraction quantile.
 */
export const baseStage: StageDef = {
  id: 'base',
  label: 'Base elevation',
  inputs: ['plates'],
  reads: ['worldSize', 'landFraction', 'macroGrid', 'coastRoughness', 'mapEdge', 'peakHeight'],
  async run(ctx) {
    const plates = ctx.input('plates').extra as PlatesExtra;
    const n = ctx.mode === 'preview' ? 256 : Number(ctx.str('macroGrid'));
    const worldKm = ctx.num('worldSize');
    const cellKm = worldKm / n;
    const noise = new Noise2(ctx.rng('noise').nextU32());
    const warpNoise = new Noise2(ctx.rng('warp').nextU32());

    // Continental crust, sampled through a warp so coasts don't trace plate boundaries.
    const crust = new Float32Array(n * n);
    const pn = plates.n;
    const warpKm = 60;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const wx = (x + 0.5) * cellKm;
        const wy = (y + 0.5) * cellKm;
        const ox = warpKm * warpNoise.fbm(wx / 250, wy / 250, 3);
        const oy = warpKm * warpNoise.fbm(wx / 250 + 41.3, wy / 250 - 12.7, 3);
        const px = Math.min(pn - 1, Math.max(0, Math.floor(((wx + ox) / worldKm) * pn)));
        const py = Math.min(pn - 1, Math.max(0, Math.floor(((wy + oy) / worldKm) * pn)));
        crust[y * n + x] = plates.continental[plates.plate[py * pn + px]];
      }
      if ((y & 63) === 0) await ctx.checkpoint();
    }
    boxBlur(crust, n, Math.max(1, Math.round(35 / cellKm)), 2);

    // Coast roughness (target fractal dimension ~1.1–1.45) maps to the fBm gain.
    const gain = Math.min(0.68, Math.max(0.35, 0.5 + (ctx.num('coastRoughness') - 1.25) * 1.2));
    const oceanEdge = ctx.str('mapEdge') === 'ocean';
    const h = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const wx = (x + 0.5) * cellKm;
        const wy = (y + 0.5) * cellKm;
        const qx = wx / 320 + 0.35 * warpNoise.fbm(wx / 500, wy / 500, 2);
        const qy = wy / 320 + 0.35 * warpNoise.fbm(wx / 500 - 7.1, wy / 500 + 3.3, 2);
        let v = 2400 * (crust[y * n + x] - 0.5) + 1100 * noise.fbm(qx, qy, 7, 2, gain);
        if (oceanEdge) {
          const e = Math.min(x, y, n - 1 - x, n - 1 - y) / n;
          v -= 3500 * (1 - smoothstep(0, 0.09, e));
        }
        h[y * n + x] = v;
      }
      if ((y & 63) === 0) await ctx.checkpoint();
    }

    const sea = quantile(h, 1 - ctx.num('landFraction'));
    let maxLand = 1;
    let minSea = -1;
    for (let i = 0; i < h.length; i++) {
      const v = h[i] - sea;
      if (v > maxLand) maxLand = v;
      if (v < minSea) minSea = v;
    }
    // Placeholder relief: the erosion model (M1) will set real heights from uplift.
    const landScale = (0.55 * ctx.range('peakHeight')[1]) / maxLand;
    const seaScale = 4500 / -minSea;
    const elev = new Float32Array(n * n);
    const land = new Uint8Array(n * n);
    let landCells = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < h.length; i++) {
      const v = h[i] - sea;
      const e = v > 0 ? v * landScale : v * seaScale;
      elev[i] = e;
      if (v > 0) {
        land[i] = 1;
        landCells++;
      }
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }

    const { sizes } = components(land, n);
    const continents = sizes.filter((s) => s >= CONTINENT_MIN_SHARE * landCells).length;

    const layers: Layer[] = [
      { id: 'elevation', label: 'Elevation', stage: 'base', kind: 'elevation', w: n, h: n, worldKm, unit: 'm', min: lo, max: hi, data: elev },
    ];
    return {
      layers,
      stats: { landFraction: landCells / (n * n), landmasses: sizes.length, continents },
      outcomes: { continentCount: continents },
      extra: { n, elev },
    };
  },
};
