/**
 * Targets the metrics are scored against. Every number cites research 05 (docs/research/05-scale-
 * density-landmarks.md) or PLAN.md §4; "(est.)" marks thresholds this harness had to choose.
 */

export type BandId = 'W' | 'R' | 'A' | 'L';

export interface BandDef {
  id: BandId;
  /** Nominal view width (km) at the default 1024 km world (research 05 §3.2). */
  nominalKm: number;
  /** W follows the world size ("W ≈ full world"); R, A and L are fixed physical widths. */
  scalesWithWorld: boolean;
  /** Target distinct scale-appropriate features per view. */
  lo: number;
  hi: number;
  /** Max empty-disk radius on land (km) at the nominal width; scaled with the view for W. */
  emptyCapKm: number;
  /** Class-entropy threshold (nats), research 05 §3.2. */
  entropyMin: number;
  /** Lowest Strahler order counted as a river at this band (research 05 §3.2 "scale-appropriate"). */
  minOrder: number;
}

export const BANDS: readonly BandDef[] = [
  { id: 'W', nominalKm: 1024, scalesWithWorld: true, lo: 15, hi: 40, emptyCapKm: 200, entropyMin: 1.2, minOrder: 6 },
  { id: 'R', nominalKm: 250, scalesWithWorld: false, lo: 10, hi: 25, emptyCapKm: 50, entropyMin: 1.2, minOrder: 4 },
  { id: 'A', nominalKm: 60, scalesWithWorld: false, lo: 8, hi: 20, emptyCapKm: 12, entropyMin: 0.8, minOrder: 2 },
  { id: 'L', nominalKm: 16, scalesWithWorld: false, lo: 6, hi: 20, emptyCapKm: 3, entropyMin: 0.8, minOrder: 1 },
];

/** Screen assumed by research 05 §3.2: ~1600 px wide; height at a 16:10 aspect. */
export const SCREEN_PX = 1600;
export const VIEW_ASPECT = 0.625;
/** "Distinct feature" size window: characteristic size in [view/80, view×1.5] (research 05 §3.2). */
export const WINDOW_LO = 1 / 80;
export const WINDOW_HI = 1.5;
/** Viewports with less land than this are ocean viewports, scored with halved targets (research 05 §3.2). */
export const OCEAN_VIEW_LAND = 0.1;

/** Per-world band pass (research 05 §5.2): p5 ≥ lo, p95 ≤ 1.5·hi, empty disk ≤ cap in ≥ 95 %. */
export const P95_SLACK = 1.5;
export const EMPTY_OK_SHARE = 0.95;
export const ENTROPY_OK_SHARE = 0.9;
/** Spatial CV of feature counts on a 4×4 grid inside the view: p50 in [0.4, 1.2] (research 05 §3.2). */
export const CV_GRID = 4;
export const CV_LO = 0.4;
export const CV_HI = 1.2;
/** M8 "done" bar (PLAN.md §14): every band and 🎯 target passes for ≥ 90 % of seeds. */
export const SEED_PASS_BAR = 0.9;

/** Contrast rules (research 05 §3.6). */
export const CONTRAST = { lowM: 300, lowShare: 0.25, highM: 2000, highShare: 0.05, kingRatio: 1.5 } as const;

/**
 * Relief-contrast target per archetype. "Old craton" is a deliberately worn-down world (research 05
 * §3.6 allows a flat-world exception): it only needs some high ground, not 5 % above 2000 m.
 */
export function contrastFor(archetype: string): { lowShare: number; highShare: number; kingRatio: number } {
  return archetype === 'craton' ? { ...CONTRAST, highShare: 0.01 } : CONTRAST;
}

/** Labels whose zoom band admits them in one screen (est.; the placer has 64 px cells, ≈ 390 per 1600×1000 screen). */
export const LABEL_CAP = 60;

/** Cluttered-seed detector (research 05 §5.3): any W view with more than this many features. */
export const CLUTTER_W_MAX = 60;
/**
 * Max class count inside any 100 km-radius disk: 3× the class's cluster target (research 05 §5.3).
 * Volcano arcs run ~10–40 per 10⁵ km² (§1.5) → ~12 per 100 km disk; peaks 5–15 per 10⁵ km² with
 * ≥ 90 % in orogens covering ~15 % of land (est.) → ~30; stored lakes ≥ ~1 km² in a lake district
 * at 10× the 10–100 km² background rate → ~50 (est.).
 */
export const DISK_CLUSTER_CAP: Readonly<Record<'volcano' | 'peak' | 'lake', number>> = { volcano: 36, peak: 90, lake: 150 };

/** Boring-seed rules (research 05 §5.3, as specified for M8). */
export const BORING = { biomeDominance: 0.7 } as const;

/** Clark–Evans targets per class (research 05 §3.3). */
export const CLARK_EVANS: Readonly<Record<string, [number, number]>> = {
  volcano: [0.4, 0.8], lake: [0.3, 0.7], peak: [0.5, 0.9], crater: [1.2, 3],
};

/** Geomorphic realism ranges (research 05 §5.4). */
export const GEOMORPH: Readonly<Record<string, [number, number]>> = {
  hortonRb: [3, 5],
  hackExponent: [0.5, 0.62],
  /** Lake N(>A) log-log slope ∈ [−1.2, −0.7] → exponent b ∈ [0.7, 1.2]. */
  lakeParetoB: [0.7, 1.2],
  korcakB: [0.45, 0.8],
  coastD: [1.1, 1.35],
};

/** Quiet land share (research 05 §3.3: reserve 10–25 % of land as low-contrast quiet zones). */
export const QUIET = { share: [0.1, 0.25] as [number, number], radiusKm: 20, minOrder: 4 } as const;

/**
 * Count targets from research 05 §4 (game-rate column). `per`: 'land' = per 10⁵ km² land,
 * 'coast' = per 1000 km coast, 'warm' = per 10⁵ km² warm ocean, 'world' = per world, 'share' = fraction.
 * `default` is the default-world count the row implies; `res` notes a grid-resolution limit.
 */
export interface CountTarget {
  key: string;
  label: string;
  per: 'land' | 'coast' | 'warm' | 'world' | 'share';
  range: [number, number];
  row: string;
  /** Also passes at exactly 0 (bimodal / optional features). */
  zeroOk?: boolean;
  note?: string;
}

/**
 * Great river (research 05 §4 row 12, restated in research 09 §4.15): Strahler order ≥ 7 is out of reach
 * on a 4.2 × 10⁵ km² world (R_b ≈ 5 gives ~6 orders), so a great river is one whose longest path from a
 * source to its sea mouth (through through-flow lakes) is at least this long (km) at the default 1024 km
 * world, scaled linearly with world width. Counted by the hydro stage as the stat `greatRivers`
 * (src/gen/stages/hydro.ts GREAT_RIVER_KM must match).
 */
export const GREAT_RIVER_KM = 400;

export const COUNT_TARGETS: readonly CountTarget[] = [
  { key: 'majorRanges', label: 'Major ranges (🎯 outcome)', per: 'world', range: [1, 3], row: '#3' },
  { key: 'peaks3k', label: 'Peaks > 3 km', per: 'land', range: [5, 15], row: '#5' },
  { key: 'ultras', label: 'Ultra peaks (prom ≥ 1.5 km)', per: 'land', range: [1, 2], row: '#6' },
  { key: 'volcanoes', label: 'Volcanoes', per: 'world', range: [8, 25], zeroOk: true, row: '#8', note: 'bimodal: 0 or 8–25' },
  { key: 'calderas', label: 'Calderas', per: 'world', range: [0, 2], row: '#9' },
  { key: 'craters', label: 'Visible craters', per: 'world', range: [0, 3], row: '#10' },
  {
    key: 'greatRivers', label: `Great rivers (≥ ${GREAT_RIVER_KM} km to the sea)`, per: 'world', range: [1, 3], row: '#12',
    note: `restated (research 09 §4.15): longest source-to-sea path ≥ ${GREAT_RIVER_KM} km × worldSize / 1024; hydro stat greatRivers`,
  },
  { key: 'rivers56', label: 'Rivers ord 5–6', per: 'land', range: [7, 10], row: '#13' },
  { key: 'riversToSea', label: 'Rivers ord ≥ 3 reaching the sea', per: 'coast', range: [20, 50], row: '#15' },
  { key: 'lakes1000', label: 'Lakes ≥ 1000 km²', per: 'world', range: [0, 2], row: '#16' },
  { key: 'lakes100', label: 'Lakes 100–1000 km²', per: 'land', range: [1, 3], row: '#17' },
  { key: 'lakes10', label: 'Lakes 10–100 km²', per: 'land', range: [8, 20], row: '#18' },
  { key: 'lakes1', label: 'Lakes 1–10 km²', per: 'land', range: [60, 150], row: '#19', note: 'below the preview cell (16 km²)' },
  { key: 'islands10k', label: 'Islands > 10 000 km²', per: 'world', range: [0, 1], row: '#21' },
  { key: 'islands100', label: 'Islands 100–10 000 km²', per: 'land', range: [2, 5], row: '#22' },
  { key: 'islands1', label: 'Islands 1–100 km²', per: 'land', range: [15, 40], row: '#23', note: 'preview resolves ≥ 16 km² only' },
  { key: 'peninsulas', label: 'Peninsulas', per: 'coast', range: [1, 3], row: '#25' },
  { key: 'fjordCoastKm', label: 'Fjord coast (km)', per: 'world', range: [300, 2000], zeroOk: true, row: '#27', note: '0 or 300–2000' },
  { key: 'ergs', label: 'Ergs', per: 'world', range: [0, 2], row: '#29' },
  { key: 'canyons', label: 'Canyons', per: 'world', range: [1, 4], row: '#30' },
  { key: 'waterfalls', label: 'Waterfalls (labelled)', per: 'land', range: [3, 8], row: '#32' },
  { key: 'deltas', label: 'Deltas (visible)', per: 'world', range: [1, 5], row: '#33' },
  { key: 'wetland', label: 'Wetland share of land', per: 'share', range: [0.04, 0.1], row: '#34' },
  { key: 'atolls', label: 'Atolls', per: 'world', range: [0, 5], row: '#38' },
  { key: 'heroes', label: 'Hero landmarks', per: 'world', range: [3, 5], row: '#42' },
];
