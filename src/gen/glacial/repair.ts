import type { Grid } from '../grid/grid';
import { FlowRouter, LAND_MIN } from '../lem/streamPower';

/**
 * Drainage repair after carving (research 01 §5: "re-run a few LEM iterations with small Δt"):
 * routes the carved surface once (Priority-Flood+ε, D8, stack, area) and runs a few implicit
 * stream-power steps without uplift on those receivers, so rivers cut through trough steps and
 * cirque lips. One routing pass instead of one per iteration keeps it inside the 1024² budget;
 * incision never lowers a cell below its receiver, so the routing stays valid for the result.
 * Only cells flagged in `active` (the carved area) are incised, so unglaciated rivers keep the
 * refine result. Only lowers terrain. Returns drainage area (m², unweighted like the refine stage),
 * receivers, and the carved cells left in closed depressions > 1 m deep (future tarns / finger lakes).
 */
export function repairDrainage(
  h: Float32Array,
  fixed: Uint8Array,
  K: Float32Array,
  g: Grid,
  m: number,
  dt: number,
  iterations: number,
  active: Uint8Array,
): { area: Float32Array; rcv: Int32Array; basinCells: number } {
  const N = g.cells;
  const router = new FlowRouter(g, fixed);
  router.route(h, null);
  const { rcv, rdist, stack, area } = router;
  const am = new Float64Array(N);
  for (let i = 0; i < N; i++) am[i] = fixed[i] ? 0 : Math.exp(m * Math.log(area[i]));
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < router.stackLen; k++) {
      const i = stack[k];
      if (fixed[i] || !active[i]) continue;
      const r = rcv[i];
      const hr = fixed[r] && h[r] < 0 ? 0 : h[r];
      const hi = h[i];
      if (hi <= hr) continue;
      const F = (K[i] * dt * am[i]) / rdist[i];
      const v = (hi + F * hr) / (1 + F);
      h[i] = v < LAND_MIN ? LAND_MIN : v;
    }
  }
  let basinCells = 0;
  for (let i = 0; i < N; i++) if (active[i] && !fixed[i] && router.filled[i] - h[i] > 1) basinCells++;
  return { area: Float32Array.from(area), rcv: rcv.slice(), basinCells };
}
