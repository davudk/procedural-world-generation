/**
 * Greedy label placement with a screen grid index and hysteresis (research 04 §5.2; Mapbox GL's
 * GridIndex + sticky placement). Pure: takes projected candidates with collision boxes and returns the
 * placed ones. One instance keeps the frame-to-frame state (what was placed, how long a newcomer has been
 * placeable).
 *
 * Rules, per frame, in priority order (forced, then heroes, then importance, then "was placed", then id):
 * - a candidate is rejected when any of its padded boxes overlaps an already placed box, or when its anchor
 *   is within the density box (~1 label per 120 × 40 px) of an already placed anchor;
 * - a label placed last frame is kept unless that happens (so it only yields to strictly higher priority:
 *   equal importance sorts previously placed first);
 * - a new label must be placeable for `stableFrames` consecutive frames before it is added, and must lie
 *   fully inside the viewport (a kept label only needs its anchor on screen) — edge hysteresis;
 * - at most ⌈area / densityArea⌉ labels in total.
 */

export interface PlacementCandidate {
  id: number;
  hero: boolean;
  importance: number;
  /** Anchor in screen px. */
  ax: number;
  ay: number;
  /** Collision boxes (x0, y0, x1, y1 groups, screen px), or null to compute lazily with `resolve`. */
  boxes: Float32Array | null;
  /** Placed first and without the stability delay (e.g. the highlighted landmark). */
  force?: boolean;
}

export interface PlacedLabel {
  id: number;
  /** Index into the candidate array passed to `place`. */
  index: number;
  boxes: Float32Array;
}

export interface PlacementOptions {
  /** Padding added around every box for the collision test (px). */
  padding: number;
  /** Grid cell size (px). */
  cellPx: number;
  /** Frames a new label must be placeable before it is shown. */
  stableFrames: number;
  /** Density box (px): no two anchors closer than half of this on both axes. */
  densityW: number;
  densityH: number;
  /** New labels must be this far inside the viewport (px). */
  edgeInset: number;
}

export const DEFAULT_PLACEMENT: PlacementOptions = { padding: 4, cellPx: 64, stableFrames: 3, densityW: 120, densityH: 40, edgeInset: 2 };

/** Uniform grid over the screen holding axis-aligned boxes; answers "does this box overlap any?". */
export class GridIndex {
  private cols = 1;
  private rows = 1;
  private heads = new Int32Array(1);
  private next = new Int32Array(256);
  private ref = new Int32Array(256);
  private box = new Float32Array(1024);
  private nBoxes = 0;
  private nEntries = 0;
  private x0 = 0;
  private y0 = 0;

  constructor(private readonly cell = 64) {}

  /** Clears the index for a viewport (with `margin` px around it). */
  reset(w: number, h: number, margin = 0): void {
    this.x0 = -margin;
    this.y0 = -margin;
    this.cols = Math.max(1, Math.ceil((w + 2 * margin) / this.cell));
    this.rows = Math.max(1, Math.ceil((h + 2 * margin) / this.cell));
    if (this.heads.length < this.cols * this.rows) this.heads = new Int32Array(this.cols * this.rows);
    this.heads.fill(-1, 0, this.cols * this.rows);
    this.nBoxes = 0;
    this.nEntries = 0;
  }

  get size(): number {
    return this.nBoxes;
  }

  private span(a0: number, a1: number, origin: number, n: number): [number, number] {
    const i0 = Math.min(n - 1, Math.max(0, Math.floor((a0 - origin) / this.cell)));
    const i1 = Math.min(n - 1, Math.max(0, Math.floor((a1 - origin) / this.cell)));
    return [i0, i1];
  }

  insert(x0: number, y0: number, x1: number, y1: number): void {
    const b = this.nBoxes++;
    if (this.box.length < this.nBoxes * 4) {
      const nb = new Float32Array(this.box.length * 2);
      nb.set(this.box);
      this.box = nb;
    }
    this.box[b * 4] = x0;
    this.box[b * 4 + 1] = y0;
    this.box[b * 4 + 2] = x1;
    this.box[b * 4 + 3] = y1;
    const [c0, c1] = this.span(x0, x1, this.x0, this.cols);
    const [r0, r1] = this.span(y0, y1, this.y0, this.rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const e = this.nEntries++;
        if (this.next.length <= e) {
          const nn = new Int32Array(this.next.length * 2);
          nn.set(this.next);
          this.next = nn;
          const nr = new Int32Array(this.ref.length * 2);
          nr.set(this.ref);
          this.ref = nr;
        }
        const k = r * this.cols + c;
        this.ref[e] = b;
        this.next[e] = this.heads[k];
        this.heads[k] = e;
      }
    }
  }

  /** True when the box overlaps (open intervals) any inserted box. */
  hits(x0: number, y0: number, x1: number, y1: number): boolean {
    const [c0, c1] = this.span(x0, x1, this.x0, this.cols);
    const [r0, r1] = this.span(y0, y1, this.y0, this.rows);
    const bx = this.box;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (let e = this.heads[r * this.cols + c]; e >= 0; e = this.next[e]) {
          const o = this.ref[e] * 4;
          if (x0 < bx[o + 2] && x1 > bx[o] && y0 < bx[o + 3] && y1 > bx[o + 1]) return true;
        }
      }
    }
    return false;
  }
}

export class LabelPlacer {
  readonly opts: PlacementOptions;
  private prev = new Set<number>();
  private stable = new Map<number, number>();
  private readonly grid: GridIndex;
  private readonly anchors: GridIndex;
  private order: number[] = [];

  constructor(opts: Partial<PlacementOptions> = {}) {
    this.opts = { ...DEFAULT_PLACEMENT, ...opts };
    this.grid = new GridIndex(this.opts.cellPx);
    this.anchors = new GridIndex(Math.max(this.opts.densityW, this.opts.densityH));
  }

  /** Was this id placed in the last `place` call? */
  wasPlaced(id: number): boolean {
    return this.prev.has(id);
  }

  /** Newcomers currently waiting for their stability frames. */
  get pending(): number {
    return this.stable.size;
  }

  /** Forgets all state (new world). */
  reset(): void {
    this.prev.clear();
    this.stable.clear();
  }

  /**
   * Places candidates for one frame. `resolve` computes boxes for candidates with `boxes === null` (it is
   * called only for candidates that survive the cheaper anchor tests) and may return null to reject.
   */
  place(
    cands: readonly PlacementCandidate[],
    viewW: number,
    viewH: number,
    resolve?: (c: PlacementCandidate, index: number) => Float32Array | null,
  ): PlacedLabel[] {
    const o = this.opts;
    const prev = this.prev;
    const order = this.order;
    order.length = cands.length;
    for (let i = 0; i < cands.length; i++) order[i] = i;
    const cmp = (ia: number, ib: number): number => {
      const a = cands[ia], b = cands[ib];
      if (!!a.force !== !!b.force) return a.force ? -1 : 1;
      if (a.hero !== b.hero) return a.hero ? -1 : 1;
      if (a.importance !== b.importance) return b.importance - a.importance;
      const pa = prev.has(a.id), pb = prev.has(b.id);
      if (pa !== pb) return pa ? -1 : 1;
      return a.id - b.id;
    };
    // Callers usually pass candidates already in priority order: check in O(n) before sorting.
    let sorted = true;
    for (let i = 1; i < order.length && sorted; i++) if (cmp(i - 1, i) > 0) sorted = false;
    if (!sorted) order.sort(cmp);

    const margin = 64;
    this.grid.reset(viewW, viewH, margin);
    this.anchors.reset(viewW, viewH, margin);
    const cap = Math.max(1, Math.ceil((viewW * viewH) / (o.densityW * o.densityH)));
    const placed: PlacedLabel[] = [];
    const nextPrev = new Set<number>();
    const nextStable = new Map<number, number>();
    const pad = o.padding;
    const hw = o.densityW / 2, hh = o.densityH / 2;
    const inset = o.edgeInset;

    for (const i of order) {
      if (placed.length >= cap) break;
      const c = cands[i];
      const kept = prev.has(c.id);
      const force = !!c.force;
      if (!(c.ax >= 0 && c.ax <= viewW && c.ay >= 0 && c.ay <= viewH)) continue;
      // Density: a point query against anchor boxes of the density size.
      if (!force && this.anchors.hits(c.ax - 1e-3, c.ay - 1e-3, c.ax + 1e-3, c.ay + 1e-3)) continue;
      const boxes = c.boxes ?? (resolve ? resolve(c, i) : null);
      if (!boxes || boxes.length < 4) continue;
      let inside = true, touches = false, collides = false;
      for (let b = 0; b < boxes.length; b += 4) {
        const x0 = boxes[b], y0 = boxes[b + 1], x1 = boxes[b + 2], y1 = boxes[b + 3];
        if (x0 < inset || y0 < inset || x1 > viewW - inset || y1 > viewH - inset) inside = false;
        if (x1 > 0 && x0 < viewW && y1 > 0 && y0 < viewH) touches = true;
        if (!collides && this.grid.hits(x0 - pad, y0 - pad, x1 + pad, y1 + pad)) collides = true;
      }
      if (collides) continue;
      if (kept ? !touches : !inside) continue;
      if (!kept && !force) {
        const s = (this.stable.get(c.id) ?? 0) + 1;
        nextStable.set(c.id, s);
        if (s < o.stableFrames) continue;
      }
      for (let b = 0; b < boxes.length; b += 4) this.grid.insert(boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3]);
      this.anchors.insert(c.ax - hw, c.ay - hh, c.ax + hw, c.ay + hh);
      nextPrev.add(c.id);
      placed.push({ id: c.id, index: i, boxes });
    }
    this.prev = nextPrev;
    this.stable = nextStable;
    return placed;
  }
}
