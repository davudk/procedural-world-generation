/**
 * Parameter hierarchy types (docs/CONFIG.md). A parameter is AUTO (derived from the resolved values
 * of its parents), PRESET (pinned by the archetype) or SET (pinned by the user).
 */

export type Range = readonly [number, number];
export type Value = number | Range | string | boolean;

export type Level = 0 | 1 | 2 | 3;

export type Section = 'world' | 'structure' | 'mountains' | 'climate' | 'water' | 'features' | 'advanced';

/** Generation stages, in pipeline order (PLAN.md §3). `param.stage` is the earliest stage that reads it. */
export const STAGE_ORDER = [
  'plates',
  'base',
  'stamps',
  'lem',
  'refine',
  'climate',
  'glacial',
  'hydro',
  'biome',
  'landforms',
  'registry',
  'gpu',
] as const;
export type StageId = (typeof STAGE_ORDER)[number];

export type Source = 'auto' | 'preset' | 'set';

/** Read access to already-resolved values while computing an AUTO value. */
export interface AutoCtx {
  num(id: string): number;
  range(id: string): Range;
  /** Midpoint of a range parameter (AUTO formulas use centres so they don't jitter with the seed). */
  mid(id: string): number;
  str(id: string): string;
  bool(id: string): boolean;
  /** Archetype bias table entry (see archetypes.ts). */
  bias(key: string): number;
  archetype: string;
}

interface ParamBase<V extends Value> {
  id: string;
  label: string;
  level: Level;
  section: Section;
  /** One-line explanation shown in the tooltip. */
  help: string;
  /** Parents this AUTO value derives from (must form a DAG; enforced in tests). */
  deps: readonly string[];
  auto: (c: AutoCtx) => V;
  /** Earliest generation stage that reads the value; changing it re-runs from here. */
  stage: StageId;
  /** 🎯 The generator steers toward this value; the realised value is reported. */
  target?: boolean;
  /** Derived for orientation only; cannot be pinned. */
  readonly?: boolean;
}

export interface NumberParam extends ParamBase<number> {
  kind: 'number';
  min: number;
  max: number;
  step: number;
  unit?: string;
  log?: boolean;
  integer?: boolean;
}

/**
 * - `draw`: one value per world, sampled from [min, max] with the seed.
 * - `spread`: the distribution of a quantity within one world.
 * - `span`: an ordered from → to span (may be descending, e.g. latitude 65 → 20).
 */
export interface RangeParam extends ParamBase<Range> {
  kind: 'draw' | 'spread' | 'span';
  min: number;
  max: number;
  step: number;
  unit?: string;
  log?: boolean;
  integer?: boolean;
}

export interface EnumParam extends ParamBase<string> {
  kind: 'enum';
  options: readonly { value: string; label: string }[];
}

export interface ToggleParam extends ParamBase<boolean> {
  kind: 'toggle';
}

export type ParamDef = NumberParam | RangeParam | EnumParam | ToggleParam;

export function isRangeParam(d: ParamDef): d is RangeParam {
  return d.kind === 'draw' || d.kind === 'spread' || d.kind === 'span';
}

/**
 * A pin. Range pins may leave one thumb on AUTO (`null`); user and archetype range pins merge per thumb.
 * `AUTO_PIN` explicitly returns a parameter to AUTO, overriding an archetype preset.
 */
export type Pin = number | string | boolean | readonly [number | null, number | null];
export const AUTO_PIN = '@auto';
export type Pins = Readonly<Record<string, Pin>>;

/** What the user controls: everything else is derived. */
export interface WorldSpec {
  seed: number;
  archetype: string;
  pins: Pins;
}

export interface Warning {
  ids: readonly string[];
  message: string;
}

export interface Resolved {
  seed: number;
  archetype: string;
  values: Record<string, Value>;
  /** AUTO value of every parameter, even pinned ones (shown as "auto would be …"). */
  autos: Record<string, Value>;
  /** Range parameters: which thumbs are pinned. Others: whole value. */
  sources: Record<string, Source | readonly [Source, Source]>;
  /** Concrete per-world value of each `draw` range. */
  drawn: Record<string, number>;
  /** Human-readable "← parent value, …" per AUTO value. */
  provenance: Record<string, string>;
  warnings: Warning[];
}
