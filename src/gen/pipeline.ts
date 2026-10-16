import type { Range, Resolved, StageId, Value } from '../shared/config/types';
import { hashValue, rngFor } from '../shared/hash';
import { copyVectors, type FromWorker, type GenMode, type Layer, type Vectors } from '../shared/protocol';
import type { Rng } from '../shared/rng';
import { flatGrid, type Grid, type MapEdge } from './grid/grid';

export interface StageOutput {
  layers: Layer[];
  stats: Record<string, number>;
  /** Realised values of 🎯 targets, keyed by parameter id. */
  outcomes: Record<string, number>;
  /** Stage-private data for downstream stages (never sent to the main thread). */
  extra?: unknown;
  /** Vector data for the renderer (rivers, lakes). */
  vectors?: Vectors;
}

export interface StageCtx {
  seed: number;
  mode: GenMode;
  num(id: string): number;
  range(id: string): Range;
  str(id: string): string;
  bool(id: string): boolean;
  /** Per-world value of a `draw` range parameter. */
  drawn(id: string): number;
  /** Independent RNG stream for this stage (CONFIG.md §6). */
  rng(...keys: (string | number)[]): Rng;
  input(id: StageId): StageOutput;
  /**
   * The world grid with n cells per face edge (research 10 §2), built once per resolution and shared
   * by every stage. The stage must read `worldSize`; its boundary (`outlets`, `hasOutside`) follows
   * `mapEdge`, which a stage must also declare before it relies on the boundary.
   */
  grid(n: number): Grid;
  /** Yields to the event loop (so newer requests can cancel this one) and reports progress. */
  checkpoint(): Promise<void>;
}

export interface StageDef {
  id: StageId;
  label: string;
  inputs: readonly StageId[];
  /** Parameters this stage reads; only these (plus inputs) invalidate its cache. */
  reads: readonly string[];
  run(ctx: StageCtx): Promise<StageOutput> | StageOutput;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface CacheEntry {
  key: number;
  out: StageOutput;
}

/**
 * Staged generation graph (PLAN.md §3). Each stage is a pure function of its read parameters, its
 * inputs and its seeded RNG, and is cached by the hash of exactly those, so changing a slider re-runs
 * only the stages that read it and everything downstream.
 */
export class Pipeline {
  private readonly cache = new Map<StageId, CacheEntry>();
  /** Grids are immutable, so they are kept across runs, keyed by size, world width and map edge. */
  private readonly grids = new Map<string, Grid>();

  constructor(readonly stages: readonly StageDef[]) {
    const seen = new Set<StageId>();
    for (const s of stages) {
      for (const i of s.inputs) if (!seen.has(i)) throw new Error(`stage ${s.id} input ${i} must come earlier`);
      seen.add(s.id);
    }
  }

  /** Cache key of every stage for a resolved config (exported for tests). */
  keys(resolved: Resolved, mode: GenMode): Map<StageId, number> {
    const keys = new Map<StageId, number>();
    for (const s of this.stages) {
      const reads: Record<string, Value> = {};
      for (const id of s.reads) {
        const v = resolved.values[id];
        if (v === undefined) throw new Error(`stage ${s.id} reads unknown parameter ${id}`);
        reads[id] = v;
        if (id in resolved.drawn) reads[`${id}#drawn`] = resolved.drawn[id];
      }
      keys.set(s.id, hashValue([s.id, mode, resolved.seed, reads, s.inputs.map((i) => keys.get(i)!)]));
    }
    return keys;
  }

  async run(
    resolved: Resolved,
    mode: GenMode,
    reqId: number,
    emit: (msg: FromWorker) => void,
    isStale: () => boolean,
  ): Promise<void> {
    const t0 = performance.now();
    const keys = this.keys(resolved, mode);
    try {
      for (const s of this.stages) {
        const key = keys.get(s.id)!;
        const hit = this.cache.get(s.id);
        if (hit && hit.key === key) {
          emit(stageDone(reqId, s, 0, true, hit.out));
          continue;
        }
        emit({ type: 'stage-start', reqId, stage: s.id, label: s.label });
        const ts = performance.now();
        const out = await s.run(this.ctx(s, resolved, mode, isStale));
        if (isStale()) throw new Cancelled();
        this.cache.set(s.id, { key, out });
        emit(stageDone(reqId, s, performance.now() - ts, false, out));
      }
      emit({ type: 'done', reqId, ms: performance.now() - t0 });
    } catch (e) {
      if (e instanceof Cancelled) emit({ type: 'cancelled', reqId });
      else emit({ type: 'error', reqId, message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
  }

  /** Cached output of a stage (tests). */
  output(id: StageId): StageOutput | undefined {
    return this.cache.get(id)?.out;
  }

  /** The cache as structured-cloneable entries (tests and metrics: hand a generated world to a worker). */
  snapshot(): [StageId, CacheEntry][] {
    return [...this.cache];
  }

  /** Loads entries from `snapshot()`; a run then re-runs only the stages they do not cover. */
  restore(entries: readonly [StageId, CacheEntry][]): void {
    for (const [id, e] of entries) this.cache.set(id, e);
  }

  private ctx(s: StageDef, resolved: Resolved, mode: GenMode, isStale: () => boolean): StageCtx {
    const get = (id: string): Value => {
      if (!s.reads.includes(id)) throw new Error(`stage ${s.id} reads undeclared parameter ${id}`);
      return resolved.values[id];
    };
    return {
      seed: resolved.seed,
      mode,
      num: (id) => get(id) as number,
      range: (id) => get(id) as Range,
      str: (id) => get(id) as string,
      bool: (id) => get(id) as boolean,
      drawn: (id) => {
        get(id);
        const d = resolved.drawn[id];
        if (d === undefined) throw new Error(`${id} is not a draw parameter`);
        return d;
      },
      rng: (...k) => rngFor(resolved.seed, s.id, ...k),
      input: (id) => {
        if (!s.inputs.includes(id)) throw new Error(`stage ${s.id} reads undeclared input ${id}`);
        const c = this.cache.get(id);
        if (!c) throw new Error(`input ${id} missing`);
        return c.out;
      },
      grid: (n) => {
        const worldKm = get('worldSize') as number;
        const edge = resolved.values.mapEdge as MapEdge;
        const key = `${n}:${worldKm}:${edge}`;
        let g = this.grids.get(key);
        if (!g) {
          if (this.grids.size >= 8) this.grids.clear();
          g = flatGrid(n, worldKm / n, edge);
          this.grids.set(key, g);
        }
        return g;
      },
      checkpoint: async () => {
        await yieldToEventLoop();
        if (isStale()) throw new Cancelled();
      },
    };
  }
}

function stageDone(reqId: number, s: StageDef, ms: number, cached: boolean, out: StageOutput): FromWorker {
  // Copies: the cache keeps the originals, and the copies are transferred.
  const layers = out.layers.map((l) => ({ ...l, data: l.data.slice() }));
  const msg: FromWorker = { type: 'stage-done', reqId, stage: s.id, label: s.label, ms, cached, layers, stats: out.stats, outcomes: out.outcomes };
  if (out.vectors) msg.vectors = copyVectors(out.vectors);
  return msg;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
