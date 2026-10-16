import type { RiverGraph } from '../../../shared/protocol';
import { emptyGraph, mergeGraphs, prepareCreeks, type CreekContext, type CreekInput } from './creekGen';

/** What the manager needs to know about the view. All positions are MAP metres (x east, y from the north edge). */
export interface CreekView {
  /** Ground point at the screen centre (camera target). */
  centerX: number;
  centerY: number;
  /** Ground radius around the centre that is on screen (m). */
  radiusM: number;
  /** Metres per pixel at the centre. */
  metresPerPixel: number;
  /** Eye position (map metres, z = metres before exaggeration). When given, far cells of tilted views get coarser tiers. */
  eye?: { x: number; y: number; z: number };
}

/** Detail tier of a cached cell. */
const TIER_NONE = 0;
const TIER_TRUNK = 1;
const TIER_FULL = 2;

interface Entry {
  tier: number;
  g: RiverGraph;
}

/**
 * Decides which macro cells need creeks for the current view, generates them time-sliced, caches them
 * per cell (LRU), and merges the visible ones into one RiverGraph for a second RiverPass.
 *
 * Tiers follow the river LOD (A_vis = (lodC · m/px / 1000)² km², research 02 §3.4): a cell's trunk is
 * generated where its drainage area would be visible, its creeks where creek areas (≤ ~½ cell) would be.
 */
export class CreekManager {
  /** Generation budget per update call (ms). */
  budgetMs = 4;
  /** Must match the creek RiverPass's `lodC`. */
  lodC = 49;
  /** Cache caps (cells and total nodes). */
  maxCells = 20_000;
  maxNodes = 600_000;
  /** While cells are still being generated, publish partial graphs at most this often (ms). */
  mergeIntervalMs = 120;
  /** Radius cap in pixels at the centre's m/px (guards horizon-length footprints of tilted views). */
  maxRadiusPx = 2000;
  readonly stats = { cellsGenerated: 0, genMs: 0, mergeMs: 0, lastNodes: 0, desired: 0, pending: 0 };

  private ctx: CreekContext | null = null;
  private readonly cache = new Map<number, Entry>();
  private nodes = 0;
  private desired: number[] = [];
  private desiredTier = new Uint8Array(0);
  private inDesired = new Uint32Array(0);
  private desiredStamp = 0;
  private queuePos = 0;
  private viewKey = '';
  private changed = false;
  private shown = false;
  private lastMerge = -Infinity;

  constructor() {}

  /** New world (or null to clear). The macro precomputation runs here (O(n²), ~50–150 ms on 1024²). */
  setWorld(input: Omit<CreekInput, 'heightAt'> | null, heightAt: CreekInput['heightAt']): void {
    this.cache.clear();
    this.nodes = 0;
    this.desired = [];
    this.queuePos = 0;
    this.viewKey = '';
    this.changed = true;
    if (!input) {
      this.ctx = null;
      return;
    }
    this.ctx = prepareCreeks({ ...input, heightAt });
    const N = input.n * input.n;
    this.desiredTier = new Uint8Array(N);
    this.inDesired = new Uint32Array(N);
  }

  /** The current context (stats, thresholds), or null without a world. */
  get context(): CreekContext | null {
    return this.ctx;
  }

  /** Call once per frame. Returns a new graph when the visible creek set changed, else null. */
  update(view: CreekView): RiverGraph | null {
    const ctx = this.ctx;
    if (!ctx) return this.clearOnce();
    const key = this.keyOf(view, ctx);
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.plan(view, ctx);
      this.changed = true;
    }
    // Generate pending cells within the budget.
    const t0 = performance.now();
    let now = t0;
    while (this.queuePos < this.desired.length && now - t0 < this.budgetMs) {
      const c = this.desired[this.queuePos++];
      const need = this.desiredTier[c];
      const have = this.cache.get(c);
      if (have && have.tier >= need) continue;
      const g = ctx.cell(c, { trunksOnly: need < TIER_FULL });
      if (have) this.nodes -= have.g.n;
      this.cache.delete(c);
      this.cache.set(c, { tier: need, g });
      this.nodes += g.n;
      this.stats.cellsGenerated++;
      this.changed = true;
      now = performance.now();
    }
    this.stats.genMs = now - t0;
    this.stats.pending = this.desired.length - this.queuePos;
    if (!this.changed) return null;
    const done = this.queuePos >= this.desired.length;
    if (!done && now - this.lastMerge < this.mergeIntervalMs) return null;
    this.evict();
    const wasShown = this.shown;
    const g = this.merge(now, done);
    return g.n === 0 && !wasShown ? null : g;
  }

  private clearOnce(): RiverGraph | null {
    if (!this.shown && !this.changed) return null;
    this.shown = false;
    this.changed = false;
    return emptyGraph();
  }

  private keyOf(v: CreekView, ctx: CreekContext): string {
    const q = ctx.cellM / 2;
    const lg = (x: number, s: number): number => Math.round(Math.log(Math.max(1e-6, x)) / s);
    const e = v.eye ? `${Math.round(v.eye.x / q)},${Math.round(v.eye.y / q)},${lg(Math.max(1, v.eye.z), 0.05)}` : '';
    return `${Math.round(v.centerX / q)},${Math.round(v.centerY / q)},${lg(v.radiusM, 0.1)},${lg(v.metresPerPixel, 0.05)},${e}`;
  }

  /** Visible area at a given m/px (km²). */
  private aVis(mpp: number): number {
    const a = (this.lodC * mpp) / 1000;
    return a * a;
  }

  /** Recomputes the wanted cells and tiers, nearest first. */
  private plan(v: CreekView, ctx: CreekContext): void {
    const { n, cellM } = ctx;
    const stamp = ++this.desiredStamp;
    const out: number[] = [];
    const prio: number[] = [];
    const mpp0 = v.metresPerPixel;
    const trunkMax = (1000 * Math.sqrt(0.98 * ctx.thresholdKm2)) / this.lodC;
    if (mpp0 <= trunkMax * 1.05) {
      const R = Math.min(v.radiusM, this.maxRadiusPx * mpp0);
      const elev = ctx.input.elevation;
      const cc = Math.min(n - 1, Math.max(0, Math.floor(v.centerY / cellM))) * n + Math.min(n - 1, Math.max(0, Math.floor(v.centerX / cellM)));
      const eyeD0 = v.eye ? Math.hypot(v.eye.x - v.centerX, v.eye.y - v.centerY, v.eye.z - Math.max(0, elev[cc])) : 0;
      const i0 = Math.max(0, Math.floor((v.centerX - R) / cellM));
      const i1 = Math.min(n - 1, Math.floor((v.centerX + R) / cellM));
      const j0 = Math.max(0, Math.floor((v.centerY - R) / cellM));
      const j1 = Math.min(n - 1, Math.floor((v.centerY + R) / cellM));
      const fullMaxArea = 0.5 * ctx.cellKm2;
      const reach = R + 0.75 * cellM;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5) * cellM;
          const y = (j + 0.5) * cellM;
          const d = Math.hypot(x - v.centerX, y - v.centerY);
          if (d > reach) continue;
          const c = j * n + i;
          let mpp = mpp0;
          if (v.eye && eyeD0 > 0) mpp = (mpp0 * Math.hypot(v.eye.x - x, v.eye.y - y, v.eye.z - Math.max(0, elev[c]))) / eyeD0;
          const av = this.aVis(mpp);
          let tier = TIER_NONE;
          if (ctx.hasCreeks(c) && av < fullMaxArea) tier = TIER_FULL;
          else if (ctx.trunkAreaKm2(c) > av) tier = TIER_TRUNK;
          if (tier === TIER_NONE) continue;
          this.desiredTier[c] = tier;
          this.inDesired[c] = stamp;
          out.push(c);
          prio.push(mpp * (1 + d / Math.max(1, R)));
        }
      }
    }
    const order = out.map((_, k) => k).sort((a, b) => prio[a] - prio[b] || out[a] - out[b]);
    this.desired = order.map((k) => out[k]);
    this.queuePos = 0;
    this.stats.desired = this.desired.length;
    // Touch cached desired cells (LRU recency).
    for (const c of this.desired) {
      const e = this.cache.get(c);
      if (e) {
        this.cache.delete(c);
        this.cache.set(c, e);
      }
    }
  }

  private evict(): void {
    if (this.cache.size <= this.maxCells && this.nodes <= this.maxNodes) return;
    const stamp = this.desiredStamp;
    for (const [c, e] of this.cache) {
      if (this.cache.size <= this.maxCells && this.nodes <= this.maxNodes) break;
      if (this.inDesired[c] === stamp) continue;
      this.cache.delete(c);
      this.nodes -= e.g.n;
    }
  }

  private merge(now: number, done: boolean): RiverGraph {
    const t0 = performance.now();
    const cells = this.desired.filter((c) => this.cache.has(c)).sort((a, b) => a - b);
    const g = mergeGraphs(cells.map((c) => this.cache.get(c)!.g));
    this.lastMerge = now;
    if (done) this.changed = false;
    this.shown = g.n > 0;
    this.stats.mergeMs = performance.now() - t0;
    this.stats.lastNodes = g.n;
    return g;
  }
}
