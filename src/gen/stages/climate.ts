import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import { minMax } from '../climate/fields';
import { computeClimate } from '../climate/model';
import type { StageDef } from '../pipeline';
import type { ErodedExtra } from './lem';

/** Climate output for later stages (hydrology, biomes). All rasters n×n, row-major. */
export interface ClimateExtra {
  n: number;
  cellKm: number;
  /** Mean annual temperature (°C) at the surface (lapsed; sea level on water). */
  temp: Float32Array;
  /** Annual precipitation (mm/yr). */
  precip: Float32Array;
  /** Holdridge potential evapotranspiration (mm/yr). */
  pet: Float32Array;
  /** Half annual temperature range (°C): warmest month = temp + tAmp, coldest = temp − tAmp. */
  tAmp: Float32Array;
  /** Share of the annual precipitation falling in the local summer half-year (0–1). */
  pSummer: Float32Array;
  /** Marine influence (1 over the sea, decaying inland along the wind). */
  marine: Float32Array;
  /** Distance to the sea (km, 0 on the sea). */
  coastKm: Float32Array;
  /** 1 = sea cell as the climate saw it (fixed base level at or below 0 m). */
  sea: Uint8Array;
  /** Warped latitude φ_eff (°). */
  lat: Float32Array;
  /** SST anomaly of coastal currents (°C): on the sea, and as advected inland. */
  sstAnom: Float32Array;
  /** 1 = coastal fog desert (cold upwelling coast in the subtropics). */
  fog: Uint8Array;
}

/**
 * S6 Climate (research 03 §1–2): zonal temperature on a warped latitude with lapse rate, ocean
 * current anomalies and continentality; summer and winter upwind moisture sweeps over latitude wind
 * bands with orographic uplift, snow-out and recycling; Holdridge PET.
 */
export const climateStage: StageDef = {
  id: 'climate',
  label: 'Climate',
  inputs: ['refine'],
  reads: [
    'worldSize', 'latitudeSpan', 'temperatureOffset', 'humidity', 'moistureLength', 'poleEquatorGradient', 'seasonality',
    'windOverrideAngle', 'windOverrideStrength', 'oceanCurrents', 'mapEdge', 'latitudeWarp', 'windNoise', 'orographicStrength',
    'rainShadowCap', 'recycling',
  ],
  async run(ctx) {
    const t = ctx.input('refine').extra as ErodedExtra;
    const { n, cellKm, h, fixed } = t;
    const [latNorth, latSouth] = ctx.range('latitudeSpan');
    const f = await computeClimate(h, fixed, n, cellKm, {
      latNorth,
      latSouth,
      tempOffset: ctx.num('temperatureOffset'),
      gradient: ctx.num('poleEquatorGradient'),
      humidity: ctx.num('humidity'),
      moistureLength: ctx.num('moistureLength'),
      seasonality: ctx.num('seasonality'),
      windOverrideAngle: ctx.num('windOverrideAngle'),
      windOverrideStrength: ctx.num('windOverrideStrength'),
      oceanCurrents: ctx.bool('oceanCurrents'),
      outsideOcean: ctx.str('mapEdge') === 'ocean',
      latitudeWarp: ctx.num('latitudeWarp'),
      windNoise: ctx.num('windNoise'),
      orographicStrength: ctx.num('orographicStrength'),
      rainShadowCap: ctx.num('rainShadowCap'),
      recycling: ctx.num('recycling'),
    }, new Noise2(ctx.rng('noise').nextU32()), () => ctx.checkpoint());

    const worldKm = ctx.num('worldSize');
    const base = { stage: 'climate' as const, kind: 'scalar' as const, w: n, h: n, worldKm };
    const [tLo, tHi] = minMax(f.temp);
    const [aLo, aHi] = minMax(f.tAmp);
    const [, pHi] = minMax(f.precip);
    const layers: Layer[] = [
      { ...base, id: 'temperature', label: 'Temperature (annual mean)', unit: '°C', min: tLo, max: tHi, data: f.temp },
      { ...base, id: 'tempRange', label: 'Temperature half-range', unit: '°C', min: aLo, max: aHi, data: f.tAmp },
      { ...base, id: 'precip', label: 'Precipitation', unit: 'mm/yr', min: 0, max: pHi, data: f.precip },
      { ...base, id: 'summerRain', label: 'Summer share of precipitation', unit: '', min: 0, max: 1, data: f.pSummer },
      { ...base, id: 'wind', label: 'Prevailing wind (toward)', unit: '°', min: 0, max: 360, data: f.windDeg },
    ];

    let land = 0;
    let tLand = 0;
    let pLand = 0;
    let fogCells = 0;
    for (let i = 0; i < n * n; i++) {
      if (f.sea[i]) continue;
      land++;
      tLand += f.temp[i];
      pLand += f.precip[i];
      fogCells += f.fog[i];
    }
    const stats: Record<string, number> = {
      ...f.stats,
      maxPrecip: Math.round(pHi),
      meanLandTemp: land ? Math.round((tLand / land) * 10) / 10 : 0,
      meanLandPrecip: land ? Math.round(pLand / land) : 0,
      fogDesertShare: land ? fogCells / land : 0,
    };
    const extra: ClimateExtra = {
      n, cellKm, temp: f.temp, precip: f.precip, pet: f.pet, tAmp: f.tAmp, pSummer: f.pSummer, marine: f.marine,
      coastKm: f.coastKm, sea: f.sea, lat: f.lat, sstAnom: f.sstAnom, fog: f.fog,
    };
    return { layers, stats, outcomes: {}, extra };
  },
};
