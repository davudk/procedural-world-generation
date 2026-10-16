import type { LandmarkKind } from '../../shared/landmarks';
import { RIVER } from '../../shared/protocol';
import type { Candidate, RegistryInput } from './types';

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
export function externalWScale(I: RegistryInput): { count: number; xs: number[]; ys: number[] } {
  const worldM = I.worldKm * 1000;
  const lo = worldM * W_SCALE_FRAC;
  let n = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const l of I.lakes) {
    if (l.type === 'playa' || Math.sqrt(l.areaKm2) * 1000 < lo) continue;
    n++;
    xs.push(l.cx);
    ys.push(l.cy);
  }
  for (const f of I.landforms.features) {
    if (!LANDFORM_PLACES.has(f.type) || f.size < lo) continue;
    n++;
    xs.push(f.x);
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
      xs.push(g.x[i]);
      ys.push(g.y[i]);
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
  external: { count: number; xs: number[]; ys: number[] },
): { kept: Candidate[]; dropped: Candidate[]; quota: number } {
  const lo = worldM * W_SCALE_FRAC;
  const quota = Math.max(W_MIN_OWN, W_WORLD_BUDGET - external.count);
  const px = external.xs.slice();
  const py = external.ys.slice();
  const d0 = SPREAD * worldM;
  const near = (c: Candidate): number => {
    let d = Infinity;
    for (let i = 0; i < px.length; i++) d = Math.min(d, Math.hypot(px[i] - c.x, py[i] - c.y));
    return d;
  };
  const spread = (c: Candidate): number => 0.2 + 0.8 * (SEA_KINDS.has(c.kind) ? 0.5 : Math.min(1, near(c) / d0));
  const place = (c: Candidate): void => {
    if (SEA_KINDS.has(c.kind)) return;
    px.push(c.x);
    py.push(c.y);
  };
  const wScale = cands.filter((c) => !FREE.has(c.kind) && c.extentM >= lo);
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
    }
  }
  for (const c of wScale) {
    if (!protectedSet.has(c) || keep.has(c)) continue;
    keep.add(c);
    place(c);
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
      const s = imp.get(c)! * KIND_DECAY ** (perKind.get(c.kind) ?? 0) * spread(c);
      if (s > bs || (s === bs && tieLess(c, rest[bi]))) (bs = s), (bi = i);
    }
    const c = rest[bi];
    rest.splice(bi, 1);
    keep.add(c);
    place(c);
    perKind.set(c.kind, (perKind.get(c.kind) ?? 0) + 1);
  }
  const drop = new Set(rest);
  return { kept: cands.filter((c) => !drop.has(c)), dropped: rest, quota };
}

function tieLess(a: Candidate, b: Candidate): boolean {
  return a.kind < b.kind || (a.kind === b.kind && (a.idX < b.idX || (a.idX === b.idX && a.idY < b.idY)));
}
