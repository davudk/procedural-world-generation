import type { Value, WorldSpec } from '../../shared/config/types';
import type { Landmark, WorldTraits } from '../../shared/landmarks';
import type { Layer } from '../../shared/protocol';

/**
 * Export payloads (PLAN.md §10 "Export"): the world JSON, the 16-bit heightmap quantisation and a
 * CPU colour map of a raster layer. Pure functions of the generated data, so they are unit-tested.
 */

export const WORLD_JSON_FORMAT = 'procedural-world/1';

export interface ExportedLandmark {
  id: number;
  name: string;
  kind: string;
  tier: string;
  hero: boolean;
  importance: number;
  /** Position in km from the west edge (x) and the north edge (y). */
  xKm: number;
  yKm: number;
  extentKm: number;
  /** Key facts from the registry (heightM, prominenceM, lengthKm, areaKm2, …). */
  facts: Record<string, number>;
}

export interface WorldJson {
  format: typeof WORLD_JSON_FORMAT;
  exportedAt: string;
  shareUrl: string;
  /** The URL state: seed + archetype + user pins (CONFIG.md §6). */
  query: string;
  spec: { seed: number; archetype: string; pins: Record<string, unknown> };
  /** Every resolved parameter value of this world (AUTO values included). */
  resolved: Record<string, Value>;
  world: { sizeKm: number; grid: number; cellKm: number; elevationM: [number, number]; seaLevelM: 0 } | null;
  heightmap: HeightmapScale | null;
  traits: (WorldTraits & { heroNames: string[] }) | null;
  landmarks: ExportedLandmark[];
}

export interface WorldJsonInput {
  spec: WorldSpec;
  query: string;
  shareUrl: string;
  resolved: Record<string, Value>;
  elevation: Layer | null;
  traits: WorldTraits | null;
  landmarks: readonly Landmark[];
  now?: Date;
}

const round = (v: number, d: number): number => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

export function buildWorldJson(inp: WorldJsonInput): WorldJson {
  const e = inp.elevation;
  const byId = new Map(inp.landmarks.map((l) => [l.id, l]));
  const landmarks = [...inp.landmarks]
    .sort((a, b) => Number(b.hero) - Number(a.hero) || b.importance - a.importance || a.id - b.id)
    .map((l): ExportedLandmark => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      tier: l.tier,
      hero: l.hero,
      importance: round(l.importance, 4),
      xKm: round(l.x / 1000, 3),
      yKm: round(l.y / 1000, 3),
      extentKm: round(l.extentM / 1000, 3),
      facts: Object.fromEntries(Object.entries(l.data).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, round(v, 3)])),
    }));
  return {
    format: WORLD_JSON_FORMAT,
    exportedAt: (inp.now ?? new Date()).toISOString(),
    shareUrl: inp.shareUrl,
    query: inp.query,
    spec: { seed: inp.spec.seed, archetype: inp.spec.archetype, pins: { ...inp.spec.pins } },
    resolved: { ...inp.resolved },
    world: e
      ? { sizeKm: e.worldKm, grid: e.w, cellKm: round(e.worldKm / e.w, 6), elevationM: [round(e.min, 2), round(e.max, 2)], seaLevelM: 0 }
      : null,
    heightmap: e ? heightmapScale(e) : null,
    traits: inp.traits ? { ...inp.traits, heroNames: inp.traits.heroes.map((id) => byId.get(id)?.name ?? `#${id}`) } : null,
    landmarks,
  };
}

// ── Heightmap ─────────────────────────────────────────────────────────────────────────────

export interface HeightmapScale {
  /** `metres = minM + value / 65535 × (maxM − minM)`; row 0 is the north edge. */
  encoding: 'uint16-linear';
  minM: number;
  maxM: number;
  width: number;
  height: number;
  /** 16-bit value of sea level (0 m), for tools that want a "sea level" setting. */
  seaLevelValue: number;
}

export function heightmapScale(e: Layer): HeightmapScale {
  // Whole metres keep the sidecar readable; the range still covers every sample.
  const minM = Math.floor(e.min);
  const maxM = Math.max(minM + 1, Math.ceil(e.max));
  return {
    encoding: 'uint16-linear', minM, maxM, width: e.w, height: e.h,
    seaLevelValue: Math.round(Math.min(1, Math.max(0, -minM / (maxM - minM))) * 65535),
  };
}

/** Elevation layer → 16-bit samples by `heightmapScale` (NaN → 0). */
export function quantizeHeights(e: Layer, s: HeightmapScale = heightmapScale(e)): Uint16Array {
  const out = new Uint16Array(e.w * e.h);
  const k = 65535 / (s.maxM - s.minM);
  for (let i = 0; i < out.length; i++) {
    const v = e.data[i];
    out[i] = Number.isFinite(v) ? Math.round(Math.min(65535, Math.max(0, (v - s.minM) * k))) : 0;
  }
  return out;
}

// ── Colour map (CPU twin of RasterView's fragment shader) ─────────────────────────────────

/** RGBA8 image of a layer at its own resolution, row 0 north: hypsometric + hillshade, categorical hues or viridis. */
export function colorizeLayer(l: Layer, hillshadeExag = 12): Uint8ClampedArray {
  const { w, h, data } = l;
  const out = new Uint8ClampedArray(w * h * 4);
  const cellM = (l.worldKm * 1000) / w;
  const at = (x: number, y: number): number => data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const L = norm3(-0.6, -0.6, 0.75);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      let c: [number, number, number];
      if (l.kind === 'categorical') c = categorical(Math.round(v));
      else if (l.kind === 'scalar') c = viridis((v - l.min) / Math.max(1e-6, l.max - l.min));
      else {
        const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * cellM);
        const dy = (at(x, y + 1) - at(x, y - 1)) / (2 * cellM);
        const n = norm3(-dx * hillshadeExag, -dy * hillshadeExag, 1);
        const shade = Math.min(1.6, Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / L[2]));
        const k = v < 0 ? 0.25 : 0.85;
        const m = 1 + (0.35 + 0.65 * shade - 1) * k;
        const hc = hypsometric(v);
        c = [hc[0] * m, hc[1] * m, hc[2] * m];
      }
      const o = (y * w + x) * 4;
      out[o] = c[0] * 255;
      out[o + 1] = c[1] * 255;
      out[o + 2] = c[2] * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

function norm3(x: number, y: number, z: number): [number, number, number] {
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}

type Rgb = [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const u = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
};

function hypsometric(h: number): Rgb {
  if (h < 0) return mix([0.33, 0.62, 0.74], [0.04, 0.12, 0.27], Math.min(1, -h / 5000) ** 0.45);
  if (h < 400) return mix([0.36, 0.55, 0.33], [0.55, 0.64, 0.38], h / 400);
  if (h < 1200) return mix([0.55, 0.64, 0.38], [0.78, 0.70, 0.47], (h - 400) / 800);
  if (h < 2500) return mix([0.78, 0.70, 0.47], [0.56, 0.44, 0.34], (h - 1200) / 1300);
  if (h < 4000) return mix([0.56, 0.44, 0.34], [0.75, 0.73, 0.72], (h - 2500) / 1500);
  return mix([0.75, 0.73, 0.72], [0.97, 0.97, 0.98], (h - 4000) / 2000);
}

function categorical(id: number): Rgb {
  const hh = (((id * 0.61803398875 + 0.13) % 1) + 1) % 1;
  const k = [0, 4, 2].map((o) => Math.min(1, Math.max(0, Math.abs((((hh * 6 + o) % 6) + 6) % 6 - 3) - 1)));
  return [0, 1, 2].map((i) => (0.5 + (k[i] - 0.5) * 0.55) * 0.85 + 0.08) as Rgb;
}

function viridis(t: number): Rgb {
  const u = Math.min(1, Math.max(0, t));
  const c: readonly Rgb[] = [
    [0.2777, 0.0054, 0.3341], [0.1050, 1.4046, 1.3846], [-0.3309, 0.2148, 0.0951],
    [-4.6342, -5.7991, -19.3324], [6.2283, 14.1799, 56.6906], [4.7764, -13.7451, -65.3530], [-5.4355, 4.6459, 26.3124],
  ];
  return [0, 1, 2].map((i) => {
    let v = c[6][i];
    for (let k = 5; k >= 0; k--) v = c[k][i] + u * v;
    return v;
  }) as Rgb;
}
