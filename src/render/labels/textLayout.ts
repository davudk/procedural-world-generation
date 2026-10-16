/**
 * Text layout helpers (pure): pen positions for a run of glyphs and curved placement along a projected
 * polyline (research 04 §5.2: per-glyph placement, reject if the turn per glyph exceeds ~25°).
 */

export interface TextRun {
  /** Offset of each glyph's centre from the start of the text, px. */
  centres: Float32Array;
  /** Advance of each glyph (without letter spacing), px. */
  widths: Float32Array;
  /** Total length of the text, px (first glyph start → last glyph end). */
  length: number;
}

/** Lays out glyph advances (× `scale` → px) with letter spacing (px) between glyphs. */
export function textRun(advances: ArrayLike<number>, spacing: number, out?: TextRun, scale = 1): TextRun {
  const n = advances.length;
  const r = out && out.centres.length === n ? out : { centres: new Float32Array(n), widths: new Float32Array(n), length: 0 };
  let pen = 0;
  for (let i = 0; i < n; i++) {
    const a = advances[i] * scale;
    r.widths[i] = a;
    r.centres[i] = pen + a / 2;
    pen += a + (i < n - 1 ? spacing : 0);
  }
  r.length = pen;
  return r;
}

export interface PathGlyphs {
  /** Glyph centres on the path (px), in reading order. */
  x: Float32Array;
  y: Float32Array;
  /** Baseline direction of each glyph (rad, screen axes, y down), within (−π/2 − ε, π/2 + ε). */
  angle: Float32Array;
  /** True when the text runs against the path direction (so it reads left to right). */
  flipped: boolean;
  /** Largest turn between neighbouring glyphs (rad). */
  maxTurn: number;
  /** Lower is better: total turning + 2 × max turn + a small penalty for being off-centre. */
  cost: number;
}

export interface PathLayoutOptions {
  /** Reject windows with a turn between neighbouring glyphs above this (rad). Default 25°. */
  maxTurn?: number;
  /** Path must be at least this × the text length. Default 1.05. */
  minRatio?: number;
  /** Number of start offsets ranked along the path. Default 17. */
  windows?: number;
}

const TWO_PI = Math.PI * 2;
let cumScratch = new Float64Array(256);
let tScratch = new Float32Array(192);
let turnScratch = new Float64Array(256);
/** Windows laid out glyph by glyph after ranking (the rest are skipped). */
const MAX_EVALUATED = 4;
function wrap(a: number): number {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/**
 * Places a text run along a screen-space polyline (`pts` = x, y pairs, `n` points): tries several start
 * offsets, keeps the straightest one that stays upright, and flips the reading direction when the path runs
 * right to left. Returns null when the path is too short or too curvy.
 */
export function layoutAlongPath(pts: ArrayLike<number>, n: number, run: TextRun, opts: PathLayoutOptions = {}): PathGlyphs | null {
  const maxTurnAllowed = opts.maxTurn ?? (25 * Math.PI) / 180;
  const minRatio = opts.minRatio ?? 1.05;
  const windows = Math.max(1, opts.windows ?? 17);
  const g = run.centres.length;
  if (n < 2 || g === 0) return null;
  if (cumScratch.length < n) cumScratch = new Float64Array(Math.max(n, cumScratch.length * 2));
  const cum = cumScratch;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  const T = cum[n - 1];
  const L = run.length;
  if (!(T >= L * minRatio) || L <= 0) return null;

  let seg = 0;
  const at = (d: number, out: { x: number; y: number }): void => {
    d = Math.min(T, Math.max(0, d));
    // Galloping search from the last segment (queries are nearly monotonic).
    if (seg > n - 2) seg = n - 2;
    while (seg > 0 && cum[seg] > d) seg--;
    while (seg < n - 2 && cum[seg + 1] < d) seg++;
    const l = cum[seg + 1] - cum[seg];
    const t = l > 0 ? (d - cum[seg]) / l : 0;
    out.x = pts[2 * seg] + (pts[2 * seg + 2] - pts[2 * seg]) * t;
    out.y = pts[2 * seg + 1] + (pts[2 * seg + 3] - pts[2 * seg + 1]) * t;
  };

  const best: PathGlyphs = { x: new Float32Array(g), y: new Float32Array(g), angle: new Float32Array(g), flipped: false, maxTurn: 0, cost: Infinity };
  if (tScratch.length < 3 * g) tScratch = new Float32Array(Math.max(3 * g, tScratch.length * 2));
  const tx = tScratch.subarray(0, g), ty = tScratch.subarray(g, 2 * g), ta = tScratch.subarray(2 * g, 3 * g);
  const p = { x: 0, y: 0 }, q = { x: 0, y: 0 }, r = { x: 0, y: 0 };
  const slack = T - L;
  // Rank the start offsets by the polyline's own turning inside each window (prefix sums over vertex
  // turns, O(log n) per window), then lay glyphs out only for the few most promising ones.
  if (turnScratch.length < n) turnScratch = new Float64Array(Math.max(n, turnScratch.length * 2));
  const tc = turnScratch;
  tc[0] = 0;
  let prevA = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
  for (let i = 1; i < n - 1; i++) {
    const a = Math.atan2(pts[2 * i + 3] - pts[2 * i + 1], pts[2 * i + 2] - pts[2 * i]);
    tc[i] = tc[i - 1] + Math.abs(wrap(a - prevA));
    prevA = a;
  }
  tc[n - 1] = tc[Math.max(0, n - 2)];
  const vertexAt = (d: number): number => {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const starts: number[] = [];
  const scores: number[] = [];
  for (let w = 0; w < windows; w++) {
    const s = windows === 1 ? slack / 2 : (slack * w) / (windows - 1);
    starts.push(s);
    scores.push(tc[vertexAt(s + L)] - tc[vertexAt(s)] + (0.5 * Math.abs(s + L / 2 - T / 2)) / T);
  }
  const rank = starts.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let tried = 0, found = 0;
  for (const w of rank) {
    if (tried >= MAX_EVALUATED || found >= 2) break;
    tried++;
    const s = starts[w];
    at(s, p);
    at(s + L, q);
    const cdx = q.x - p.x, cdy = q.y - p.y;
    const flipped = cdx < -1e-6 || (Math.abs(cdx) <= 1e-6 && cdy < 0);
    let maxTurn = 0, sumTurn = 0, ok = true;
    for (let i = 0; i < g; i++) {
      const c = run.centres[i];
      const d = flipped ? s + L - c : s + c;
      const half = Math.max(run.widths[i] / 2, 2);
      at(d, r);
      tx[i] = r.x;
      ty[i] = r.y;
      at(d - half, p);
      at(d + half, q);
      let a = Math.atan2(q.y - p.y, q.x - p.x);
      if (flipped) a = wrap(a + Math.PI);
      if (Math.cos(a) < -0.17) {
        ok = false; // this glyph would read upside down: the path turns back inside the window
        break;
      }
      ta[i] = a;
      if (i > 0) {
        const t = Math.abs(wrap(a - ta[i - 1]));
        if (t > maxTurn) maxTurn = t;
        sumTurn += t;
      }
    }
    if (!ok || maxTurn > maxTurnAllowed) continue;
    const cost = sumTurn + 2 * maxTurn + (0.5 * Math.abs(s + L / 2 - T / 2)) / T;
    found++;
    if (cost < best.cost) {
      best.x.set(tx);
      best.y.set(ty);
      best.angle.set(ta);
      best.flipped = flipped;
      best.maxTurn = maxTurn;
      best.cost = cost;
    }
  }
  return Number.isFinite(best.cost) ? best : null;
}
