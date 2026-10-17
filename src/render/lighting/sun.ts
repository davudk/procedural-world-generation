/**
 * Time of day and season (M9): a simple solar model at a fixed mid latitude, and the light, sky and
 * haze colours it implies (research 04 §3, "optional time of day"). Purely a render-time effect.
 *
 * The sun keeps the cartographic convention: at the default time and season it sits exactly at the
 * top-left of the screen at 40° elevation (the pre-M9 look), and other times rotate it by the true
 * solar azimuth change. The night side only dims, with a faint blue moonlight from the opposite side.
 */

/** Render-time view settings (not world config). */
export interface ViewSettings {
  /** Local solar time, hours 0–24. */
  time: number;
  /** Fraction of the year from 1 January (northern hemisphere seasons). */
  season: number;
  /** Time of day applies; off, the light is the fixed cartographic sun of the map modes. */
  sun: boolean;
  /** Seasons apply; off, flat maps show the default season and globes the annual mean. */
  seasons: boolean;
  /** Clouds and cloud shadows on. */
  clouds: boolean;
  /** Time of day advancing on its own. */
  animate: boolean;
}

type Rgb = [number, number, number];

/** Fixed latitude of the solar model (the world is a flat region with no real latitude of its own). */
const LATITUDE = (45 * Math.PI) / 180;
/** Default season: late July, the warm peak, which is what the biome colours already show. */
export const DEFAULT_SEASON = 0.55;
/** Default elevation of the pre-M9 cartographic sun. */
const DEFAULT_ELEVATION = (40 * Math.PI) / 180;

/** Solar declination (rad) for a fraction of the year; 0 at the March equinox (≈ 21 March). */
export function declination(season: number): number {
  return ((23.44 * Math.PI) / 180) * Math.sin(2 * Math.PI * (season - 0.22));
}

/** Unit vector toward the sun in local east-north-up axes. */
export function solarVector(time: number, season: number, lat = LATITUDE): Rgb {
  const H = ((time - 12) / 24) * 2 * Math.PI; // hour angle, positive in the afternoon
  const d = declination(season);
  return [
    -Math.cos(d) * Math.sin(H),
    Math.sin(d) * Math.cos(lat) - Math.cos(d) * Math.sin(lat) * Math.cos(H),
    Math.sin(d) * Math.sin(lat) + Math.cos(d) * Math.cos(lat) * Math.cos(H),
  ];
}

/** Afternoon time at which the default-season sun stands at the default elevation (≈ 15:50). */
export const DEFAULT_TIME = ((): number => {
  let lo = 12;
  let hi = 20;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (Math.asin(solarVector(mid, DEFAULT_SEASON)[2]) > DEFAULT_ELEVATION) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
})();

const A0 = ((): number => {
  const v = solarVector(DEFAULT_TIME, DEFAULT_SEASON);
  return Math.atan2(v[0], v[1]);
})();

export const DEFAULT_VIEW: ViewSettings = { time: DEFAULT_TIME, season: DEFAULT_SEASON, sun: true, seasons: true, clouds: true, animate: false };

/** March equinox (declination 0), the season of a globe without seasons. */
export const EQUINOX_SEASON = 0.22;

/** Lighting derived from the sun model for one frame. */
export interface SunLight {
  /** Unit vector toward the light that casts shadows (the sun, or the moon at night). */
  dir: Rgb;
  /** Unit vector toward the sun itself (sky glow). */
  sunDir: Rgb;
  /** Sine of the sun's elevation (negative at night). */
  sinEl: number;
  /** Direct light colour × intensity (1,1,1 at the default). */
  light: Rgb;
  /** Ambient (sky) light multiplier (1,1,1 at the default). */
  ambient: Rgb;
  skyHorizon: Rgb;
  skyZenith: Rgb;
  /** Sun glow colour in the sky. */
  glow: Rgb;
  /** Valley-fog strength from the sun: strongest around sunrise, none in the afternoon. */
  fog: number;
}

const DAY_HORIZON: Rgb = [0.62, 0.70, 0.78];
const DAY_ZENITH: Rgb = [0.22, 0.38, 0.62];
const DUSK_HORIZON: Rgb = [0.90, 0.62, 0.44];
const DUSK_ZENITH: Rgb = [0.20, 0.27, 0.48];
const NIGHT_HORIZON: Rgb = [0.05, 0.07, 0.12];
const NIGHT_ZENITH: Rgb = [0.012, 0.02, 0.05];

/**
 * Light for a time, season and camera bearing (rad). The defaults reproduce the pre-M9 constants
 * exactly: every colour ramp saturates above ~27° of sun elevation. Globes pass the target's latitude.
 */
export function sunLight(time: number, season: number, bearing: number, lat = LATITUDE): SunLight {
  const v = solarVector(time, season, lat);
  const sinEl = v[2];
  const cosEl = Math.sqrt(Math.max(0, 1 - sinEl * sinEl));
  // Cartographic azimuth (light from the top-left of the screen) plus the true solar azimuth change.
  const az = bearing - Math.PI / 4 + (Math.atan2(v[0], v[1]) - A0);
  const sunDir: Rgb = [Math.sin(az) * cosEl, Math.cos(az) * cosEl, sinEl];
  const day = smoothstep(-0.05, 0.08, sinEl);
  const warm = 1 - smoothstep(0.05, 0.45, sinEl);
  const night = 1 - smoothstep(-0.12, 0, sinEl);
  const twilight = smoothstep(-0.15, 0.05, sinEl);
  const sunCol = mixRgb([1, 1, 1], [1.0, 0.62, 0.36], warm);
  const sunI = day * (1 - 0.3 * warm);
  const moonI = 0.22 * night;
  let dir: Rgb;
  let light: Rgb;
  if (sinEl > -0.03) {
    // Shading needs a light above the horizon: hold the setting sun just above it while it dims.
    const z = Math.max(sinEl, 0.03);
    const k = Math.sqrt(1 - z * z);
    dir = [Math.sin(az) * k, Math.cos(az) * k, z];
    light = [sunCol[0] * sunI, sunCol[1] * sunI, sunCol[2] * sunI];
  } else {
    // Moon opposite the sun at 35°; swapped in while both lights are nearly off.
    const z = Math.sin((35 * Math.PI) / 180);
    const k = Math.cos((35 * Math.PI) / 180);
    dir = [-Math.sin(az) * k, -Math.cos(az) * k, z];
    light = [0.55 * moonI, 0.68 * moonI, 1.0 * moonI];
  }
  const amb = smoothstep(-0.14, 0.25, sinEl);
  // A low sun leaves most slopes in shadow: the bright dawn/dusk sky fills them in (+50 %).
  const fill = 1 + 0.5 * warm * day;
  const ambient = mixRgb([0.10, 0.13, 0.24], mixRgb([fill, fill, fill], [1.08 * fill, 0.92 * fill, 0.86 * fill], warm * day), amb);
  const dusk = 1 - smoothstep(0.0, 0.35, sinEl);
  const skyHorizon = mixRgb(NIGHT_HORIZON, mixRgb(DAY_HORIZON, DUSK_HORIZON, dusk), twilight);
  const skyZenith = mixRgb(NIGHT_ZENITH, mixRgb(DAY_ZENITH, DUSK_ZENITH, dusk), twilight);
  const glowK = 0.35 + 0.45 * warm;
  const glow = mixRgb([1.0, 0.92, 0.75], [1.0, 0.55, 0.28], warm).map((c) => c * glowK * day) as Rgb;
  // Fog forms overnight and burns off a few hours after sunrise; it lingers less in the evening.
  const morning = time < 12 ? 1 : 0.2;
  const fog = (1 - smoothstep(0.08, 0.5, sinEl)) * mix(0.55, 1, morning) * mix(1, 0.6, night);
  return { dir, sunDir, sinEl, light, ambient, skyHorizon, skyZenith, glow, fog };
}

/** Phase of the seasonal temperature cycle: cos = 1 at the warm peak (the default season). */
export function seasonPhase(season: number): { cos: number; sin: number } {
  const a = 2 * Math.PI * (season - DEFAULT_SEASON);
  return { cos: Math.cos(a), sin: Math.sin(a) };
}

/** "hh:mm" for a time in hours. */
export function formatTime(t: number): string {
  const m = Math.round((((t % 24) + 24) % 24) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "early Jul" style label for a season fraction. */
export function formatSeason(s: number): string {
  const f = (((s % 1) + 1) % 1) * 12;
  const m = Math.floor(f);
  const part = f - m < 1 / 3 ? 'early' : f - m < 2 / 3 ? 'mid' : 'late';
  return `${part} ${MONTHS[m]}`;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
