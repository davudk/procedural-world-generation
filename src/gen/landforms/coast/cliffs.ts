import type { LandformCtx } from '../types';
import { COAST, type CoastInfo } from './classify';
import { DiskSet, DX8, DY8, poisson, shuffle } from './grid';

// Local copies: hot loops should not read the imported bindings.
const DX = Int8Array.from(DX8);
const DY = Int8Array.from(DY8);

/** Sea stacks per 1000 km of exposed cliff coast at density 1 (FEATURES F12: uncommon). */
const STACK_RATE = 8;
const STACK_CAP = 60;
const STACK_SPACING_KM = 6;

/**
 * Sea cliffs (F11) on high, exposed coasts: the first land cells are pulled up toward the ground
 * just inland (never above it, so no pits form and valley mouths stay open), and the first sea cells
 * are deepened, so the coastal step reads as a cliff. Writes the `cliff` mask (cliff height, 255 at
 * ≥ 150 m) and places sea stacks (F12) as point features a few hundred metres off eroding cliffs.
 * Returns the cliff coast length (km) and the stack count.
 */
export function placeCliffs(c: LandformCtx, info: CoastInfo, edited: Uint8Array, mask: Uint8Array): { km: number; stacks: number } {
  const { n, cellKm, h } = c;
  const { sea, cells, slot, cls, wave } = info;
  const rng = c.rng('coastal', 'cliffs');
  const cliffCells: number[] = [];
  let km = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (cls[k] !== COAST.ROCKY || h[i] <= 0 || c.fixed[i] || edited[i]) continue;
    const x = i % n;
    const y = (i - x) / n;
    // Lowest interior (non-coastal) land neighbour: the cliff top may rise to just below it.
    let lo = Infinity;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d];
      const yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const j = yy * n + xx;
      if (sea[j] || slot[j] >= 0) continue;
      lo = Math.min(lo, h[j]);
    }
    const strength = Math.min(1, Math.max(0, (wave[k] - 0.15) / 0.35));
    if (lo !== Infinity && strength > 0) {
      const target = Math.min(lo - 0.5, h[i] + strength * 0.9 * (lo - h[i]));
      if (target > h[i]) {
        h[i] = target;
        edited[i] = 1;
      }
    }
    const top = h[i];
    if (top < 20 || strength <= 0) continue;
    cliffCells.push(k);
    mask[i] = Math.max(mask[i], Math.min(255, Math.round((top / 150) * 255)));
    // Deepen the sea cells at the cliff foot (wave-cut platform edge).
    let e = 0;
    for (let d = 0; d < 4; d++) {
      const xx = x + DX[d];
      const yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const j = yy * n + xx;
      if (!sea[j]) continue;
      e++;
      const foot = -(6 + 0.12 * top) * strength;
      if (h[j] > foot) {
        h[j] = foot;
        edited[j] = 1;
      }
    }
    km += e * cellKm * (Math.PI / 4);
  }

  // Sea stacks: Poisson count per cliff length, Poisson-disk spaced, just off the cliff foot.
  const want = Math.min(STACK_CAP, poisson(rng, (STACK_RATE * c.num('density_coast') * km) / 1000));
  shuffle(rng, cliffCells);
  const disk = new DiskSet(STACK_SPACING_KM);
  let stacks = 0;
  for (const k of cliffCells) {
    if (stacks >= want) break;
    if (wave[k] < 0.35) continue;
    const i = cells[k];
    const cx = ((i % n) + 0.5) * cellKm;
    const cy = (Math.floor(i / n) + 0.5) * cellKm;
    const offKm = cellKm * 0.5 + rng.range(0.1, 0.8);
    const px = cx + info.nx[k] * offKm;
    const py = cy + info.ny[k] * offKm;
    const gx = Math.floor(px / cellKm);
    const gy = Math.floor(py / cellKm);
    if (gx < 0 || gy < 0 || gx >= n || gy >= n || !sea[gy * n + gx]) continue;
    if (!disk.free(px, py)) continue;
    disk.add(px, py);
    stacks++;
    const size = rng.range(40, 250);
    c.features.push({ type: 'sea-stack', x: px * 1000, y: py * 1000, size, data: { height: rng.range(15, 70) } });
    // Stacks are far below a macro cell; only a grid finer than the stack gets a bump.
    if (size >= cellKm * 1000) h[gy * n + gx] = Math.max(h[gy * n + gx], 10);
  }

  // Cliff features: one per contiguous stretch of ≥ ~10 km, from a coarse walk over cliff cells.
  const seen = new Uint8Array(n * n);
  for (const k of cliffCells) seen[cells[k]] = 1;
  for (const k of cliffCells) {
    const s = cells[k];
    if (seen[s] !== 1) continue;
    const stack = [s];
    seen[s] = 2;
    let count = 0;
    let sx = 0;
    let sy = 0;
    let top = 0;
    while (stack.length) {
      const q = stack.pop()!;
      count++;
      const x = q % n;
      const y = (q - x) / n;
      sx += x;
      sy += y;
      top = Math.max(top, h[q]);
      for (let d = 0; d < 8; d++) {
        const xx = x + DX[d];
        const yy = y + DY[d];
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        if (seen[j] === 1) {
          seen[j] = 2;
          stack.push(j);
        }
      }
    }
    if (count * cellKm < 10) continue;
    c.features.push({
      type: 'sea-cliff', x: (sx / count + 0.5) * cellKm * 1000, y: (sy / count + 0.5) * cellKm * 1000,
      size: count * cellKm * 1000, data: { height: top },
    });
  }
  return { km, stacks };
}
