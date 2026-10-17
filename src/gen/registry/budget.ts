import type { LandmarkKind } from '../../shared/landmarks';
import { RIVER } from '../../shared/protocol';
import type { Geo } from './geo';
import type { Candidate, RegistryInput, Shared } from './types';

/**
 * Interest budget of the world band (research 05 §3.2): a W view (the whole world width) should hold
 * 15–40 distinct features whose characteristic size is at least view/80. The registry cannot change
 * what hydrology and the landform pass put on the map, so it counts those first (big lakes, trunk
 * rivers of Strahler order ≥ 6, landform features with no landmark of their own) and fills the rest
 * of a per-world budget with its own W-scale candidates by importance, with diminishing returns per
 * kind so the budget buys variety (ten bays are worth less than a bay, a desert and a plateau).
 */

/** Smallest feature that reads at band W: view / 80 (research 05 §3.2), the view being the world width. */
export const W_SCALE_FRAC = 1 / 80;
/**
 * W-scale features per world, all sources, before the world-band fill (fill.ts) adds region names to
 * land the budget left empty. A land-weighted W view covers ~60–70 % of them: 50 per world plus the
 * fill puts the median W view at 36–43 features with p95 under 1.5 × 40 (M8 tuning, 20 seeds × 10 archetypes).
 */
const W_WORLD_BUDGET = 50;
/** The registry keeps at least this many W-scale landmarks whatever hydrology and landforms add. */
const W_MIN_OWN = 18;
/**
 * Spheres: band W is a fixed 1,024 km cap (research 10 §7), the size of the flat default world, not the
 * planet's equal-area size. The world-band budget, the world fill and the W label tier work at that
 * scale, with the per-world numbers of a flat 1024 km world per (1,024 km)² of planet (research 11 §4).
 */
export const SPHERE_W_CAP_M = 1_024_000;

/**
 * Spheres: a W-scale candidate is only kept while fewer than SPHERE_W_LOCAL_CAP kept W-scale features
 * (the registry's and the external ones) lie within SPHERE_W_LOCAL_RADIUS_M along the surface. A flat
 * W view is the whole world, so its budget is its view budget; a land-centred 1,024 km cap on a planet
 * sees far more land than the planet's average, so a planet-wide quota alone crowded such views (p95 of
 * 70–100 features on island worlds, research 11 §4).
 */
const SPHERE_W_LOCAL_RADIUS_M = SPHERE_W_CAP_M / 2;
const SPHERE_W_LOCAL_CAP = 40;

/** View width (m) of band W and how many such views the world's area holds (flat: the world, 1). */
export function wBand(worldM: number, geo: Geo): { viewM: number; views: number } {
  if (!geo.sphere) return { viewM: worldM, views: 1 };
  return { viewM: SPHERE_W_CAP_M, views: (4 * Math.PI * geo.R * geo.R) / (SPHERE_W_CAP_M * SPHERE_W_CAP_M) };
}
/** Importance multiplier per earlier pick of the same kind. */
const KIND_DECAY = 0.72;
/** Kinds with at least SIGNATURE_MIN world-scale candidates keep their SIGNATURE_KEEP best. */
const SIGNATURE_MIN = 6;
const SIGNATURE_KEEP = 3;
/** Kinds that never compete (whole-world structure, or not counted as places: rivers and lakes are scored from hydrology). */
const FREE: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['continent', 'ocean', 'river', 'lake']);
/** Landform features with no landmark of their own that read as places (counted against the budget). */
const LANDFORM_PLACES = new Set(['sea-stack', 'spit', 'tombolo', 'barrier-island', 'inselberg', 'ria', 'cinder-field', 'cenote', 'geothermal']);
/**
 * Spread: a land candidate's score is scaled by 0.2 + 0.8·min(1, d / (SPREAD · world width)), d the
 * distance to the nearest W-scale land feature already kept, so the budget also keeps the largest empty
 * disk of a W view small (≤ 200 km, research 05 §3.2). Sea kinds score as if half-way.
 */
const SPREAD = 0.2;
const SEA_KINDS: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['ocean', 'sea', 'gulf', 'bay', 'strait', 'lagoon', 'reef', 'atoll']);
/** Strahler order of a W-scale river (research 05 §3.2: major rivers ord ≥ 6). */
const W_RIVER_ORDER = 6;

/** W-scale features the registry does not own: big lakes, trunk rivers and landform places. */
export function externalWScale(I: RegistryInput, S: Shared): { count: number; xs: number[]; ys: number[] } {
  const lo = wBand(I.worldKm * 1000, S.geo).viewM * W_SCALE_FRAC;
  let n = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const l of I.lakes) {
    if (l.type === 'playa' || Math.sqrt(l.areaKm2) * 1000 < lo) continue;
    n++;
    xs.push(S.geo.enc(l.face, l.cx));
    ys.push(l.cy);
  }
  for (const f of I.landforms.features) {
    if (!LANDFORM_PLACES.has(f.type) || f.size < lo) continue;
    n++;
    xs.push(S.geo.enc(f.face, f.x));
    ys.push(f.y);
  }
  // Rivers: one per maximal run of one Strahler order ≥ W_RIVER_ORDER.
  const g = I.rivers;
  const maxIn = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d >= 0 && !(g.flags[i] & RIVER.DISTRIBUTARY)) maxIn[d] = Math.max(maxIn[d], g.strahler[i]);
  }
  for (let i = 0; i < g.n; i++) {
    if (g.flags[i] & RIVER.DISTRIBUTARY) continue;
    const s = g.strahler[i];
    if (s >= W_RIVER_ORDER && maxIn[i] < s) {
      n++;
      xs.push(S.rivX[i]);
      ys.push(S.rivY[i]);
    }
  }
  return { count: n, xs, ys };
}

/**
 * Drops the W-scale candidates that do not fit the budget. Heroes, the world king, continents and
 * oceans are always kept. Returns the kept list (order preserved) and the number dropped.
 */
export function applyWBudget(
  cands: Candidate[], imp: Map<Candidate, number>, protectedSet: ReadonlySet<Candidate>, worldM: number,
  external: { count: number; xs: number[]; ys: number[] }, geo: Geo,
): { kept: Candidate[]; dropped: Candidate[]; quota: number } {
  const { viewM, views } = wBand(worldM, geo);
  const lo = viewM * W_SCALE_FRAC;
  const quota = Math.max(W_MIN_OWN * views, W_WORLD_BUDGET * views - external.count);
  const d0 = SPREAD * viewM;
  const wScale = cands.filter((c) => !FREE.has(c.kind) && c.extentM >= lo);
  // Distance from each W-scale candidate to the nearest kept land feature, updated as features are
  // placed (the same minimum as a scan of every placed feature, in O(candidates) per placement).
  const nearD = new Map<Candidate, number>();
  for (const c of wScale) {
    let d = Infinity;
    for (let i = 0; i < external.xs.length; i++) d = Math.min(d, geo.dist(external.xs[i], external.ys[i], c.x, c.y));
    nearD.set(c, d);
  }
  const spread = (c: Candidate): number => 0.2 + 0.8 * (SEA_KINDS.has(c.kind) ? 0.5 : Math.min(1, nearD.get(c)! / d0));
  const place = (c: Candidate): void => {
    if (SEA_KINDS.has(c.kind)) return;
    for (const o of wScale) {
      if (SEA_KINDS.has(o.kind)) continue;
      const d = geo.dist(c.x, c.y, o.x, o.y);
      if (d < nearD.get(o)!) nearD.set(o, d);
    }
  };
  const crowd = geo.sphere ? new LocalCrowd(geo, wScale, external, SPHERE_W_LOCAL_RADIUS_M) : null;
  const keep = new Set<Candidate>();
  // A kind with many world-scale instances characterises the world (fjords of a fjordland, islands of
  // an archipelago): its best SIGNATURE_KEEP always stay.
  const byKind = new Map<string, Candidate[]>();
  for (const c of wScale) {
    const a = byKind.get(c.kind);
    if (a) a.push(c);
    else byKind.set(c.kind, [c]);
  }
  for (const list of byKind.values()) {
    if (list.length < SIGNATURE_MIN) continue;
    list.sort((a, b) => imp.get(b)! - imp.get(a)! || (tieLess(a, b) ? -1 : tieLess(b, a) ? 1 : 0));
    for (const c of list.slice(0, SIGNATURE_KEEP)) {
      keep.add(c);
      place(c);
      crowd?.add(c);
    }
  }
  for (const c of wScale) {
    if (!protectedSet.has(c) || keep.has(c)) continue;
    keep.add(c);
    place(c);
    crowd?.add(c);
  }
  const perKind = new Map<string, number>();
  for (const c of keep) perKind.set(c.kind, (perKind.get(c.kind) ?? 0) + 1);
  const rest = wScale.filter((c) => !keep.has(c));
  // Greedy: the best remaining candidate after the per-kind decay, until the quota is spent.
  while (keep.size < quota && rest.length) {
    let bi = -1;
    let bs = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (crowd && crowd.full(c, SPHERE_W_LOCAL_CAP)) continue;
      const s = imp.get(c)! * KIND_DECAY ** (perKind.get(c.kind) ?? 0) * spread(c);
      if (s > bs || (s === bs && tieLess(c, rest[bi]))) (bs = s), (bi = i);
    }
    if (bi < 0) break;
    const c = rest[bi];
    rest.splice(bi, 1);
    keep.add(c);
    place(c);
    crowd?.add(c);
    perKind.set(c.kind, (perKind.get(c.kind) ?? 0) + 1);
  }
  const drop = new Set(rest);
  return { kept: cands.filter((c) => !drop.has(c)), dropped: rest, quota };
}

function tieLess(a: Candidate, b: Candidate): boolean {
  return a.kind < b.kind || (a.kind === b.kind && (a.idX < b.idX || (a.idX === b.idX && a.idY < b.idY)));
}

/** Spheres: how many kept W-scale features lie within a radius of each candidate (see SPHERE_W_LOCAL_CAP). */
class LocalCrowd {
  private readonly n = new Map<Candidate, number>();

  constructor(
    private readonly geo: Geo,
    private readonly cands: readonly Candidate[],
    external: { xs: number[]; ys: number[] },
    private readonly radiusM: number,
  ) {
    for (const c of cands) {
      let k = 0;
      for (let i = 0; i < external.xs.length; i++) if (geo.dist(external.xs[i], external.ys[i], c.x, c.y) <= radiusM) k++;
      this.n.set(c, k);
    }
  }

  add(c: Candidate): void {
    for (const o of this.cands) if (this.geo.dist(c.x, c.y, o.x, o.y) <= this.radiusM) this.n.set(o, this.n.get(o)! + 1);
  }

  full(c: Candidate, cap: number): boolean {
    return this.n.get(c)! >= cap;
  }
}
