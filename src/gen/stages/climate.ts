import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import { boxBlur, chamferDistance, smoothstep } from '../grid/ops';
import type { StageDef } from '../pipeline';
import type { ErodedExtra } from './lem';

export interface ClimateExtra {
  n: number;
  cellKm: number;
  /** Mean annual temperature (°C) at the surface. */
  temp: Float32Array;
  /** Annual precipitation (mm/yr). */
  precip: Float32Array;
  /** Potential evapotranspiration (mm/yr). */
  pet: Float32Array;
}

/**
 * S6 Climate — M3 placeholder so hydrology has rain and evaporation (M4 replaces it with the
 * wind/moisture model of research 03). Zonal temperature with lapse rate; precipitation from a
 * latitude circulation factor (wet tropics, dry subtropics, wet mid-latitudes), distance inland and
 * an elevation boost; PET from temperature.
 */
export const climateStage: StageDef = {
  id: 'climate',
  label: 'Climate',
  inputs: ['refine'],
  reads: ['worldSize', 'latitudeSpan', 'temperatureOffset', 'humidity', 'moistureLength', 'poleEquatorGradient'],
  async run(ctx) {
    const t = ctx.input('refine').extra as ErodedExtra;
    const { n, cellKm, h } = t;
    const N = n * n;
    const [latN, latS] = ctx.range('latitudeSpan');
    const tOff = ctx.num('temperatureOffset');
    const grad = ctx.num('poleEquatorGradient');
    const humidity = ctx.num('humidity');
    const L = ctx.num('moistureLength');
    const noise = new Noise2(ctx.rng('noise').nextU32());

    const sea = new Uint8Array(N);
    for (let i = 0; i < N; i++) sea[i] = h[i] <= 0 ? 1 : 0;
    const coast = chamferDistance(sea, n);
    await ctx.checkpoint();

    const temp = new Float32Array(N);
    const precip = new Float32Array(N);
    const pet = new Float32Array(N);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const wx = (x + 0.5) * cellKm;
        const wy = (y + 0.5) * cellKm;
        const lat = latN + (latS - latN) * (y / n) + 3 * noise.fbm(wx / 500, wy / 500, 2);
        const a = Math.abs(lat);
        const elev = Math.max(0, h[i]);
        const t0 = 28 - grad * 0.0075 * a * a;
        temp[i] = t0 - 0.0065 * elev + tOff;
        // Circulation: ITCZ wet, subtropical highs dry (~27°), storm tracks wet (~50°).
        const S = Math.max(0.12, 0.45 + 1.1 * Math.exp(-((a / 11) ** 2)) - 0.55 * Math.exp(-(((a - 27) / 9) ** 2)) + 0.45 * Math.exp(-(((a - 50) / 13) ** 2)));
        const inland = 0.3 + 0.7 * Math.exp(-(coast[i] * cellKm) / L);
        const oro = 1 + 0.5 * smoothstep(200, 2500, elev);
        precip[i] = 1000 * humidity * S * inland * oro * (1 + 0.25 * noise.fbm(wx / 180 + 9, wy / 180, 3));
        pet[i] = Math.max(150, 300 + 55 * Math.max(0, temp[i]));
      }
      if ((y & 63) === 0) await ctx.checkpoint();
    }
    boxBlur(precip, n, Math.max(1, Math.round(8 / cellKm)), 1);

    const worldKm = ctx.num('worldSize');
    let pMax = 0;
    let tLo = Infinity;
    let tHi = -Infinity;
    for (let i = 0; i < N; i++) {
      pMax = Math.max(pMax, precip[i]);
      tLo = Math.min(tLo, temp[i]);
      tHi = Math.max(tHi, temp[i]);
    }
    const layers: Layer[] = [
      { id: 'precip', label: 'Precipitation', stage: 'climate', kind: 'scalar', w: n, h: n, worldKm, unit: 'mm/yr', min: 0, max: pMax, data: precip },
      { id: 'temperature', label: 'Temperature', stage: 'climate', kind: 'scalar', w: n, h: n, worldKm, unit: '°C', min: tLo, max: tHi, data: temp },
    ];
    const extra: ClimateExtra = { n, cellKm, temp, precip, pet };
    return { layers, stats: { maxPrecip: pMax }, outcomes: {}, extra };
  },
};
