import { cellIndex, cellX as colOf, cellY as rowOf } from '../grid/grid';
import { chamferDistance } from '../grid/ops';
import { RIVER } from '../../shared/protocol';
import type { LandmarkKind } from '../../shared/landmarks';
import { BIOME } from '../../shared/biomes';
import { cellAtM, cellX, cellY, label, nearestWhere } from './grid';
import { G, groupOf } from './shared';
import type { ReliefResult } from './relief';
import type { Candidate, RegistryInput, Shared } from './types';

/**
 * Interest fill for the region and area bands (research 05 §3.2: a 250 km view should hold 10–25
 * features with no empty land disk wider than 50 km, a 60 km view 8–20 with none wider than 12 km and
 * more than one class of feature). The M8 baseline found the land between orogens and lake districts
 * empty at R, and nothing but rivers at A. Low ground is not featureless: it has hills and rises, the
 * summits of the elevation merge tree too low for a labelled peak. This pass names the most prominent
 * of them that stand far from every other feature of the band: at R, land farther than `fillKm` from
 * any region-scale feature; at A, summits farther than the area spacing from every other point
 * feature (rivers do not count there: they are already ~90 % of what an area view holds). An
 * area-band summit of ≥ A_PEAK_PROM is a peak (a lower tier than the labelled peaks), lower ones hills.
 */

interface Band {
  /** Size window of a "distinct feature" of the band (m): [view/80, view × 1.5]. */
  lo: number;
  hi: number;
  /** New summits keep this far (km) from the band's features. */
  fillKm: number;
  /** Rivers of this Strahler order and up cover land (0: rivers are not counted). */
  riverOrder: number;
  /** Minimum prominence (m) and the cap on the footprint (m). */
  minProm: number;
  maxExtentM: number;
  /** Only summits whose footprint is below this (m): area-band summits must not crowd the region band. */
  below: number;
}

/** Region band: 250 km views; fill at about half the 50 km empty-disk cap; rivers ord ≥ 4 are features there. */
const R_BAND: Band = { lo: 250000 / 80, hi: 250000 * 1.5, fillKm: 33, riverOrder: 4, minProm: 10, maxExtentM: 12000, below: Infinity };
/**
 * Area band: 60 km views. Summits keep 5 km from other point features: up to ~10 per view where the
 * relief allows, the share of non-river features an entropy ≥ 0.8 needs next to ~20 rivers.
 */
const A_BAND: Band = { lo: 60000 / 80, hi: 60000 * 1.5, fillKm: 5, riverOrder: 0, minProm: 20, maxExtentM: 12000, below: R_BAND.lo };
/** Area-band summits of this prominence (m) and up are peaks (labelled peaks need 300 m). */
const A_PEAK_PROM = 150;
/** Region-band fill summits of this prominence and up (a volcano summit freed by the world budget) are peaks. */
const R_PEAK_PROM = 300;
/** Below this prominence (m) a hill is a low rise (naming variant). */
const RISE_PROM = 120;
/** Kinds that mark nothing on land (sea areas) or never count as a place at these bands. */
const NOT_LAND: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['ocean', 'sea', 'gulf', 'bay', 'strait', 'lagoon', 'reef', 'atoll', 'continent']);
const LANDFORM_PLACES = new Set(['sea-stack', 'spit', 'tombolo', 'barrier-island', 'inselberg', 'ria', 'cinder-field', 'cenote', 'geothermal']);

export function fillSummits(I: RegistryInput, S: Shared, out: Candidate[], relief: ReliefResult): { r: number; a: number } {
  const r = fillBand(I, S, out, relief, R_BAND, false);
  const a = fillBand(I, S, out, relief, A_BAND, true);
  return { r, a };
}

function fillBand(I: RegistryInput, S: Shared, out: Candidate[], relief: ReliefResult, B: Band, area: boolean): number {
  const { n, cellM } = I.fine;
  const fine = I.fine;
  // Coverage raster: the macro grid for the area band, the ~4 km regional grid for the region band.
  const cg = area ? fine : S.reg;
  const covered = new Uint8Array(cg.cells);
  const mark = (x: number, y: number): void => {
    covered[cellAtM(cg, x, y)] = 1;
  };
  for (const c of out) {
    if (NOT_LAND.has(c.kind) || c.kind === 'river' || c.extentM < B.lo || c.extentM > B.hi) continue;
    mark(c.x, c.y);
    if (c.path && !area) for (let i = 0; i + 1 < c.path.length; i += 2) mark(c.path[i], c.path[i + 1]);
  }
  const g = I.rivers;
  if (B.riverOrder > 0) for (let i = 0; i < g.n; i++) if (g.strahler[i] >= B.riverOrder && !(g.flags[i] & RIVER.DISTRIBUTARY)) mark(g.x[i], g.y[i]);
  for (const l of I.lakes) if (Math.sqrt(l.areaKm2) * 1000 >= B.lo) mark(l.cx, l.cy);
  for (const f of I.landforms.features) if (LANDFORM_PLACES.has(f.type) && f.size >= B.lo) mark(f.x, f.y);
  const dist = chamferDistance(covered, cg);
  const fillCells = (B.fillKm * 1000) / cg.cellM;
  const far = (c: number): boolean => dist[area ? c : cellAtM(cg, cellX(fine, c), cellY(fine, c))] >= fillCells;

  const { tree: t, prom, used } = relief;
  const cellKm2 = (cellM / 1000) ** 2;
  const summits: FillItem[] = [];
  const ks: number[] = [];
  for (let k = 0; k < t.count; k++) {
    // Roots are the summits of whole landmasses: an island's top is a hill of its own.
    if (used[k] || prom[k] < B.minProm) continue;
    const foot = Math.sqrt(t.area[k] * cellKm2) * 1000;
    if (foot < B.lo || foot >= B.below) continue;
    const c = t.peak[k];
    if (I.sea[c] || !far(c)) continue;
    ks.push(k);
  }
  ks.sort((a, b) => prom[b] - prom[a] || a - b);
  ks.forEach((k, i) => {
    const c = t.peak[k];
    summits.push({
      rank: i / ks.length, c, claim: () => {
        used[k] = 1;
      },
      make: () => {
        const p = prom[k];
        const x = cellX(fine, c);
        const y = cellY(fine, c);
        const ext = Math.min(B.maxExtentM, Math.sqrt(t.area[k] * cellKm2) * 1000);
        const isPeak = p >= (area ? A_PEAK_PROM : R_PEAK_PROM);
        return {
          kind: isPeak ? 'peak' : 'hill', x, y, angle: NaN, extentM: ext, visM: isPeak ? 1000 * (p / 300) ** 0.9 : ext,
          mag: isPeak ? 0.4 * Math.min(1, p / 3000) : Math.min(1, p / 600),
          data: { heightM: Math.round(t.peakV[k]), prominenceM: Math.round(p) }, idX: x, idY: y,
          ...(!isPeak && p < RISE_PROM ? { variant: 'rise' } : {}), tier: 'common', landmass: S.masses.label[c],
        };
      },
    });
  });
  const items = area ? summits : [...summits, ...patches(I, S, B, far)];
  // Interleave the classes by their rank within each class (most prominent hill, largest wood, …).
  items.sort((a, b) => a.rank - b.rank || a.c - b.c);
  // Accepted fills in a hash grid of fillKm buckets.
  const bucketM = B.fillKm * 1000;
  const nb = Math.ceil((n * cellM) / bucketM);
  const buckets = new Map<number, number[]>();
  const fill2 = bucketM * bucketM;
  let added = 0;
  for (const it of items) {
    const x = cellX(fine, it.c);
    const y = cellY(fine, it.c);
    const bx = Math.floor(x / bucketM);
    const by = Math.floor(y / bucketM);
    let ok = true;
    for (let j = by - 1; j <= by + 1 && ok; j++) {
      for (let i = bx - 1; i <= bx + 1 && ok; i++) {
        if (i < 0 || j < 0 || i >= nb || j >= nb) continue;
        const pts = buckets.get(j * nb + i);
        if (pts) for (let q = 0; q < pts.length && ok; q += 2) if ((pts[q] - x) ** 2 + (pts[q + 1] - y) ** 2 < fill2) ok = false;
      }
    }
    if (!ok) continue;
    const key = by * nb + bx;
    const b = buckets.get(key);
    if (b) b.push(x, y);
    else buckets.set(key, [x, y]);
    it.claim?.();
    added++;
    out.push(it.make());
  }
  return added;
}

interface FillItem {
  /** Rank within its class, 0 = best. */
  rank: number;
  /** Macro cell of the anchor. */
  c: number;
  make: () => Candidate;
  claim?: () => void;
}

/** Largest area (km²) of a wood or marsh patch named by the fill: larger ones are biome regions. */
const PATCH_MAX_KM2 = 160;

/**
 * Small woods and marshes: connected patches of a forest or wetland biome on the macro grid, between
 * the band's smallest feature and PATCH_MAX_KM2, standing in land not already covered.
 */
function patches(I: RegistryInput, S: Shared, B: Band, far: (c: number) => boolean): FillItem[] {
  const fine = I.fine;
  const N = fine.cells;
  const cellKm2 = (fine.cellM / 1000) ** 2;
  const out: FillItem[] = [];
  for (const [kind, groups] of [['forest', [G.BOREAL, G.TEMPERATE, G.TROPICAL]], ['wetland', [G.WET]]] as const) {
    const mask = new Uint8Array(N);
    for (let c = 0; c < N; c++) if (!I.sea[c] && (groups as readonly number[]).includes(groupOf(I.biome.biome[c], I.hydro.waterClass[c]))) mask[c] = 1;
    const comps = label(mask, fine, true);
    const list: { k: number; c: number; a: number }[] = [];
    for (let k = 0; k < comps.count; k++) {
      const a = comps.size[k] * cellKm2;
      if (Math.sqrt(a) * 1000 < B.lo || a > PATCH_MAX_KM2) continue;
      const c = nearestWhere(fine, comps.sx[k] / comps.size[k] + 0.5, comps.sy[k] / comps.size[k] + 0.5, Math.max(4, Math.sqrt(comps.size[k])), (q) => comps.label[q] === k);
      if (c < 0 || !far(c)) continue;
      list.push({ k, c, a });
    }
    list.sort((p, q) => q.a - p.a || p.c - q.c);
    list.forEach(({ c, a }, i) => {
      out.push({
        rank: i / list.length, c,
        make: () => {
          const x = cellX(I.fine, c);
          const y = cellY(I.fine, c);
          const b = I.biome.biome[c];
          const variant = kind === 'forest' ? 'wood' : b === BIOME.BOG || b === BIOME.FEN ? 'moss' : 'fen';
          return {
            kind, x, y, angle: NaN, extentM: Math.sqrt(a) * 1000, mag: Math.min(1, a / 2000), data: { areaKm2: Math.round(a) },
            idX: x, idY: y, variant, tier: 'common', landmass: S.masses.label[c],
          };
        },
      });
    });
  }
  return out;
}

/**
 * World-band fill: land farther than W_FILL_FRAC × world width from every world-scale land feature
 * (research 05 §3.2: no empty land disk wider than 200 km in a 1024 km view) gets the biome region it
 * lies in, named on the spot: the forest, open country, desert or wetland that covers most of the
 * land within W_FILL_RADIUS_FRAC × world width. Big biome regions are named once at their pole; this
 * names the far reaches of the same cover (as real maps name several forests of one forest belt).
 * Runs after the world-band budget (on what it kept) and is not budgeted itself; marked `wFill`.
 */
const W_FILL_FRAC = 0.15;
const W_FILL_RADIUS_FRAC = 0.07;
/** Share of the land in the disk the dominant cover needs. */
const W_FILL_MIN_SHARE = 0.4;

export function fillWorld(I: RegistryInput, S: Shared, out: Candidate[]): number {
  const R = S.reg;
  const MM = R.cells;
  const worldM = I.worldKm * 1000;
  const lo = worldM / 80;
  const covered = new Uint8Array(MM);
  const mark = (x: number, y: number): void => {
    covered[cellAtM(R, x, y)] = 1;
  };
  for (const c of out) {
    if (NOT_LAND.has(c.kind) || c.kind === 'river' || c.kind === 'lake' || c.extentM < lo) continue;
    mark(c.x, c.y);
    if (c.path) for (let i = 0; i + 1 < c.path.length; i += 2) mark(c.path[i], c.path[i + 1]);
  }
  const g = I.rivers;
  for (let i = 0; i < g.n; i++) if (g.strahler[i] >= 6 && !(g.flags[i] & RIVER.DISTRIBUTARY)) mark(g.x[i], g.y[i]);
  for (const l of I.lakes) if (l.type !== 'playa' && Math.sqrt(l.areaKm2) * 1000 >= lo) mark(l.cx, l.cy);
  for (const f of I.landforms.features) if (LANDFORM_PLACES.has(f.type) && f.size >= lo) mark(f.x, f.y);
  const rad = (W_FILL_RADIUS_FRAC * worldM) / R.cellM;
  const need = (W_FILL_FRAC * worldM) / R.cellM;
  const rKm2 = (R.cellM / 1000) ** 2;
  const covers: [string, string, number[]][] = [
    ['forest', 'taiga', [G.BOREAL]], ['forest', 'forest', [G.TEMPERATE]], ['forest', 'jungle', [G.TROPICAL]],
    ['grassland', 'open', [G.OPEN]], ['grassland', 'tundra', [G.TUNDRA]], ['desert', 'desert', [G.DESERT]], ['wetland', 'marsh', [G.WET]],
  ];
  let added = 0;
  const tried = new Uint8Array(MM);
  for (let guard = 0; guard < 64; guard++) {
    const dist = chamferDistance(covered, R);
    let best = -1;
    for (let i = 0; i < MM; i++) if (S.land[i] && !tried[i] && dist[i] > need && (best < 0 || dist[i] > dist[best])) best = i;
    if (best < 0) break;
    tried[best] = 1;
    const bx = colOf(R, best);
    const by = rowOf(R, best);
    const r = Math.ceil(rad);
    const sum = new Float64Array(covers.length);
    let landSum = 0;
    const xb = Math.min(R.n - 1, bx + r);
    const yb = Math.min(R.n - 1, by + r);
    for (let y = Math.max(0, by - r); y <= yb; y++) {
      for (let x = Math.max(0, bx - r); x <= xb; x++) {
        const dx = x - bx;
        const dy = y - by;
        if (dx * dx + dy * dy > rad * rad) continue;
        const c = cellIndex(R, x, y);
        landSum += S.landShare[c];
        covers.forEach(([, , gs], k) => {
          for (const gg of gs) sum[k] += S.groupShare[gg][c];
        });
      }
    }
    let k = -1;
    for (let j = 0; j < covers.length; j++) if (k < 0 || sum[j] > sum[k]) k = j;
    if (k < 0 || landSum <= 0 || sum[k] < W_FILL_MIN_SHARE * landSum) {
      // Nothing dominant here: leave it (and its neighbourhood) quiet.
      covered[best] = 1;
      continue;
    }
    const [kind, v] = covers[k];
    const areaKm2 = sum[k] * rKm2;
    const fc = nearestWhere(I.fine, cellX(R, best) / I.fine.cellM, cellY(R, best) / I.fine.cellM, 3 * S.f, (q) => !I.sea[q]);
    const x = fc >= 0 ? cellX(I.fine, fc) : cellX(R, best);
    const y = fc >= 0 ? cellY(I.fine, fc) : cellY(R, best);
    let variant = v;
    if (kind === 'grassland' && v === 'open') {
      const b = I.biome.biome[fc >= 0 ? fc : cellAtM(I.fine, x, y)];
      variant = b === BIOME.SAVANNA ? 'savanna' : b === BIOME.STEPPE ? 'steppe' : 'scrub';
    }
    if (kind === 'desert') {
      const t = I.climate.temp[fc >= 0 ? fc : cellAtM(I.fine, x, y)];
      variant = t < -5 ? 'polar' : t < 12 ? 'cold' : 'hot';
    }
    out.push({
      kind: kind as LandmarkKind, x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000, mag: Math.min(1, areaKm2 / 200000),
      data: { areaKm2: Math.round(areaKm2), wFill: 1 }, idX: x, idY: y, variant, tier: 'common',
      landmass: fc >= 0 ? S.masses.label[fc] : -1,
    });
    mark(x, y);
    added++;
  }
  return added;
}
