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
    }
  | { type: 'done'; reqId: number; ms: number }
  | { type: 'cancelled'; reqId: number }
  | { type: 'error'; reqId: number; message: string };

/** Transferable buffers of a message (layers only). */
export function transferablesOf(msg: FromWorker): ArrayBuffer[] {
  return msg.type === 'stage-done' ? msg.layers.map((l) => l.data.buffer as ArrayBuffer) : [];
}
