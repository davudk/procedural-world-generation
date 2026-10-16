import type { Resolved, StageId } from './config/types';

/** How a raster should be coloured by the debug viewer. */
export type LayerKind = 'elevation' | 'categorical' | 'scalar';

export type LayerData = Float32Array | Int32Array | Uint8Array | Uint16Array;

/** A row-major raster covering the whole world (PLAN.md §3 data contracts). */
export interface Layer {
  id: string;
  label: string;
  stage: StageId;
  kind: LayerKind;
  w: number;
  h: number;
  /** World width in km (cells are square: worldKm / w). */
  worldKm: number;
  unit: string;
  min: number;
  max: number;
  data: LayerData;
}

/** River node flags (research 02 §9). */
export const RIVER = {
  SOURCE: 1,
  CONFLUENCE: 2,
  MOUTH_SEA: 4,
  MOUTH_LAKE: 8,
  LAKE_TERMINAL: 16,
  SINK_DRY: 32,
  LAKE_IN: 64,
  LAKE_OUT: 128,
  WATERFALL: 256,
  RAPIDS: 512,
  EPHEMERAL: 1024,
  BRAIDED: 2048,
  DISTRIBUTARY: 4096,
  DELTA: 8192,
} as const;

/**
 * River network as struct-of-arrays (research 02 §9). Positions are MAP metres: x from the west edge,
 * y from the NORTH edge (down), like the rasters. Nodes are stored reach by reach: reach r is
 * nodes [reachStart[r], reachStart[r] + reachLen[r]) from upstream to downstream; its last node's
 * `down` is a node of reach `reachDown[r]` (or −1 at a mouth / sink).
 */
export interface RiverGraph {
  n: number;
  x: Float32Array;
  y: Float32Array;
  /** Water surface and bed elevation (m); non-increasing downstream. */
  zWater: Float32Array;
  zBed: Float32Array;
  /** Mean annual discharge (m³/s) and drainage area (km²). */
  q: Float32Array;
  area: Float32Array;
  /** Channel width and depth (m). */
  width: Float32Array;
  depth: Float32Array;
  strahler: Uint8Array;
  down: Int32Array;
  flags: Uint16Array;
  reachStart: Uint32Array;
  reachLen: Uint32Array;
  reachDown: Int32Array;
  /** Smallest drainage area along the reach (km²): the LOD key. */
  reachMinArea: Float32Array;
}

export type LakeType = 'basin' | 'rift' | 'tarn' | 'finger' | 'kettle' | 'crater' | 'oxbow' | 'salt' | 'playa' | 'pond';

export interface LakeInfo {
  id: number;
  type: LakeType;
  /** Surface elevation (m). */
  level: number;
  areaKm2: number;
  maxDepth: number;
  /** Centroid, map metres. */
  cx: number;
  cy: number;
  /** River node that leaves the lake, −1 if terminal. */
  outletNode: number;
  /** 0 fresh, 1 brackish, 2 saline. */
  salinity: 0 | 1 | 2;
}

/** Non-raster stage outputs, sent alongside layers. */
export interface Vectors {
  rivers?: RiverGraph;
  lakes?: LakeInfo[];
}

export type GenMode = 'preview' | 'build';

export type ToWorker = { type: 'generate'; reqId: number; resolved: Resolved; mode: GenMode };

export type FromWorker =
  | { type: 'stage-start'; reqId: number; stage: StageId; label: string }
  | {
      type: 'stage-done';
      reqId: number;
      stage: StageId;
      label: string;
      ms: number;
      cached: boolean;
      layers: Layer[];
      stats: Record<string, number>;
      /** Realised values of 🎯 target parameters, keyed by parameter id. */
      outcomes: Record<string, number>;
      vectors?: Vectors;
    }
  | { type: 'done'; reqId: number; ms: number }
  | { type: 'cancelled'; reqId: number }
  | { type: 'error'; reqId: number; message: string };

/** Transferable buffers of a message (layers only). */
export function transferablesOf(msg: FromWorker): ArrayBuffer[] {
  if (msg.type !== 'stage-done') return [];
  const out = msg.layers.map((l) => l.data.buffer as ArrayBuffer);
  const r = msg.vectors?.rivers;
  if (r) {
    for (const v of Object.values(r)) if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  }
  return out;
}

/** Deep copy of vectors (the worker keeps originals in its stage cache and transfers copies). */
export function copyVectors(v: Vectors): Vectors {
  const out: Vectors = {};
  if (v.rivers) {
    const r = v.rivers;
    out.rivers = {
      n: r.n, x: r.x.slice(), y: r.y.slice(), zWater: r.zWater.slice(), zBed: r.zBed.slice(), q: r.q.slice(),
      area: r.area.slice(), width: r.width.slice(), depth: r.depth.slice(), strahler: r.strahler.slice(), down: r.down.slice(),
      flags: r.flags.slice(), reachStart: r.reachStart.slice(), reachLen: r.reachLen.slice(), reachDown: r.reachDown.slice(),
      reachMinArea: r.reachMinArea.slice(),
    };
  }
  if (v.lakes) out.lakes = v.lakes.map((l) => ({ ...l }));
  return out;
}
