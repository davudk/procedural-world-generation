import type { Routing } from './routing';

/** How a cell-level reach ends. */
export const END = { CONFLUENCE: 0, SEA: 1, LAKE: 2, LAKE_TERMINAL: 3, PLAYA: 4, DRY: 5 } as const;
/** How a cell-level reach starts. */
export const HEAD = { SOURCE: 0, CONFLUENCE: 1, LAKE_OUT: 2 } as const;

export interface LakeLink {
  /** Lake index per cell, −1 elsewhere. */
  lakeId: Int32Array;
  /** Per lake: 0 through-flow, 1 terminal, 2 playa. */
  kind: Uint8Array;
}

export interface CellNetwork {
  chan: Uint8Array;
  strahler: Uint8Array;
  reachOfCell: Int32Array;
  /** Cells of reach r: cells[start[r] .. start[r] + len[r]), upstream first. Reaches are upstream-first. */
  cells: Int32Array;
  start: Int32Array;
  len: Int32Array;
  down: Int32Array;
  head: Uint8Array;
  end: Uint8Array;
  /** Lake cell the reach leaves from (LAKE_OUT heads), else −1. */
  fromLakeCell: Int32Array;
  /** Through-flow lake exits that go straight into another lake or the sea (no channel cell between). */
  connectors: { from: number; to: number }[];
  /** Every through-flow lake exit: lake cell → first cell outside the lake. */
  exits: { from: number; to: number }[];
}

/**
 * Channel cells (drainage area ≥ threshold, water still flowing, not under a lake) plus the path below
 * every lake outlet, split into reaches between confluences (research 02 §3, §4.1), with Strahler
 * order carried through lakes.
 */
export function extractNetwork(
  R: Routing,
  area: Float64Array,
  q: Float64Array,
  fixed: Uint8Array,
  lakes: LakeLink,
  minAreaKm2: number,
  minQ: number,
): CellNetwork {
  const { rcv, stack, donStart, donList } = R;
  const { lakeId, kind } = lakes;
  const N = rcv.length;
  const chan = new Uint8Array(N);
  for (let i = 0; i < N; i++) chan[i] = !fixed[i] && lakeId[i] < 0 && area[i] >= minAreaKm2 && q[i] >= minQ ? 1 : 0;

  const connectors: { from: number; to: number }[] = [];
  const exits: { from: number; to: number }[] = [];
  for (let i = 0; i < N; i++) {
    const l = lakeId[i];
    if (l < 0 || kind[l] !== 0) continue;
    const r = rcv[i];
    if (r === i || lakeId[r] === l) continue;
    exits.push({ from: i, to: r });
    if (fixed[r] || lakeId[r] >= 0) {
      connectors.push({ from: i, to: r });
      continue;
    }
    for (let c = r; !chan[c] && !fixed[c] && lakeId[c] < 0; c = rcv[c]) {
      chan[c] = 1;
      if (rcv[c] === c) break;
    }
  }

  const strahler = new Uint8Array(N);
  const carry = new Uint8Array(N);
  const isHead = new Uint8Array(N);
  const fromLake = new Int32Array(N).fill(-1);
  for (let k = N - 1; k >= 0; k--) {
    const i = stack[k];
    const inLake = lakeId[i] >= 0;
    if (!chan[i] && !inLake) continue;
    let best = 0;
    let ties = 0;
    let incoming = 0;
    let chanIn = 0;
    for (let d = donStart[i]; d < donStart[i + 1]; d++) {
      const j = donList[d];
      let v = 0;
      if (chan[j]) {
        v = strahler[j];
        chanIn++;
      } else if (lakeId[j] >= 0 && lakeId[j] !== lakeId[i]) {
        v = Math.max(1, carry[j]);
        if (chan[i]) fromLake[i] = j;
      } else if (inLake && lakeId[j] === lakeId[i]) {
        carry[i] = Math.max(carry[i], carry[j]);
        continue;
      } else {
        continue;
      }
      incoming++;
      if (v > best) {
        best = v;
        ties = 1;
      } else if (v === best) {
        ties++;
      }
    }
    if (inLake) {
      carry[i] = Math.max(carry[i], best);
      continue;
    }
    strahler[i] = best === 0 ? 1 : Math.min(255, best + (ties >= 2 ? 1 : 0));
    isHead[i] = incoming === 1 && chanIn === 1 ? 0 : 1;
  }

  // Reach ids in reverse stack order: upstream reaches first.
  const reachOfCell = new Int32Array(N).fill(-1);
  const heads: number[] = [];
  for (let k = N - 1; k >= 0; k--) {
    const i = stack[k];
    if (chan[i] && isHead[i]) {
      reachOfCell[i] = heads.length;
      heads.push(i);
    }
  }
  const nr = heads.length;
  const start = new Int32Array(nr);
  const len = new Int32Array(nr);
  const down = new Int32Array(nr).fill(-1);
  const head = new Uint8Array(nr);
  const end = new Uint8Array(nr);
  const fromLakeCell = new Int32Array(nr).fill(-1);
  const cells: number[] = [];
  for (let r = 0; r < nr; r++) {
    const h0 = heads[r];
    start[r] = cells.length;
    let chanIn = 0;
    for (let d = donStart[h0]; d < donStart[h0 + 1]; d++) if (chan[donList[d]]) chanIn++;
    head[r] = fromLake[h0] >= 0 ? HEAD.LAKE_OUT : chanIn >= 2 ? HEAD.CONFLUENCE : HEAD.SOURCE;
    fromLakeCell[r] = fromLake[h0];
    let c = h0;
    for (;;) {
      cells.push(c);
      reachOfCell[c] = r;
      const nx = rcv[c];
      if (nx !== c && chan[nx] && !isHead[nx]) {
        c = nx;
        continue;
      }
      if (nx === c) end[r] = END.DRY;
      else if (fixed[nx]) end[r] = END.SEA;
      else if (lakeId[nx] >= 0) end[r] = kind[lakeId[nx]] === 0 ? END.LAKE : kind[lakeId[nx]] === 1 ? END.LAKE_TERMINAL : END.PLAYA;
      else if (chan[nx]) {
        end[r] = END.CONFLUENCE;
        down[r] = reachOfCell[nx];
      } else end[r] = END.DRY;
      break;
    }
    len[r] = cells.length - start[r];
  }
  return { chan, strahler, reachOfCell, cells: Int32Array.from(cells), start, len, down, head, end, fromLakeCell, connectors, exits };
}
