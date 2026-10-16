import { rngFor } from '../hash';
import { archetypeById } from './archetypes';
import { PARAMS, PARAM_BY_ID } from './schema';
import {
  AUTO_PIN,
  isRangeParam,
  type AutoCtx,
  type ParamDef,
  type Pin,
  type Range,
  type Resolved,
  type Source,
  type Value,
  type Warning,
  type WorldSpec,
} from './types';

/** Parameters in dependency order (parents first). Throws on cycles or unknown deps. */
export function dependencyOrder(params: readonly ParamDef[] = PARAMS): ParamDef[] {
  const byId = new Map(params.map((p) => [p.id, p]));
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const out: ParamDef[] = [];
  const visit = (p: ParamDef, path: string[]): void => {
    const s = state.get(p.id);
    if (s === 2) return;
    if (s === 1) throw new Error(`parameter cycle: ${[...path, p.id].join(' → ')}`);
    state.set(p.id, 1);
    for (const d of p.deps) {
      const dp = byId.get(d);
      if (!dp) throw new Error(`${p.id} depends on unknown ${d}`);
      visit(dp, [...path, p.id]);
    }
    state.set(p.id, 2);
    out.push(p);
  };
  for (const p of params) visit(p, []);
  return out;
}

const ORDER = dependencyOrder();

/** Clamps to bounds and snaps to the step grid (integer params to whole numbers). */
function snap(d: ParamDef & { min: number; max: number; step: number; integer?: boolean }, v: number): number {
  const x = Math.min(d.max, Math.max(d.min, v));
  if (d.integer) return Math.min(d.max, Math.max(d.min, Math.round(x / Math.max(1, d.step)) * Math.max(1, d.step)));
  const decimals = Math.max(0, -Math.floor(Math.log10(d.step) + 1e-9));
  return Math.min(d.max, Math.max(d.min, Number((Math.round(x / d.step) * d.step).toFixed(decimals + 2))));
}

type ThumbPin = readonly [number | null, number | null];

/** Per-thumb merge of a user range pin over an archetype range pin, with the source of each thumb. */
function mergeRangePins(user: Pin | undefined, preset: Pin | undefined): { pin: ThumbPin; src: [Source, Source] } {
  const u: ThumbPin = Array.isArray(user) ? (user as ThumbPin) : [null, null];
  const p: ThumbPin = Array.isArray(preset) && user !== AUTO_PIN ? (preset as ThumbPin) : [null, null];
  const thumb = (i: 0 | 1): [number | null, Source] => (u[i] != null ? [u[i], 'set'] : p[i] != null ? [p[i], 'preset'] : [null, 'auto']);
  const [a, sa] = thumb(0);
  const [b, sb] = thumb(1);
  return { pin: [a, b], src: [sa, sb] };
}

/** Combines an AUTO value with an optional pin, clamped to bounds. `pinSrc` labels the pin's origin. */
function combine(d: ParamDef, auto: Value, pin: Pin | undefined, pinSrc: Source): { value: Value; source: Source | readonly [Source, Source] } {
  if (pin === AUTO_PIN) pin = undefined;
  switch (d.kind) {
    case 'number': {
      const v = typeof pin === 'number' ? pin : (auto as number);
      return { value: snap(d, v), source: typeof pin === 'number' ? pinSrc : 'auto' };
    }
    case 'enum': {
      const chosen = typeof pin === 'string' && d.options.some((o) => o.value === pin) ? pin : null;
      return { value: chosen ?? (auto as string), source: chosen !== null ? pinSrc : 'auto' };
    }
    case 'toggle':
      return { value: typeof pin === 'boolean' ? pin : (auto as boolean), source: typeof pin === 'boolean' ? pinSrc : 'auto' };
    default: {
      const a = auto as Range;
      const p = Array.isArray(pin) ? (pin as ThumbPin) : [null, null];
      let lo = snap(d, p[0] ?? a[0]);
      let hi = snap(d, p[1] ?? a[1]);
      const src: [Source, Source] = [p[0] != null ? pinSrc : 'auto', p[1] != null ? pinSrc : 'auto'];
      if (d.kind !== 'span' && lo > hi) {
        // A pinned thumb wins; the AUTO thumb moves to meet it.
        if (src[0] !== 'auto' && src[1] === 'auto') hi = lo;
        else if (src[1] !== 'auto' && src[0] === 'auto') lo = hi;
        else [lo, hi] = [hi, lo];
      }
      return { value: [lo, hi] as Range, source: src };
    }
  }
}

function fmt(d: ParamDef, v: Value): string {
  const unit = 'unit' in d && d.unit ? d.unit : '';
  if (Array.isArray(v)) {
    if (unit === '°') return `${fmtNum(v[0])}°${d.kind === 'span' ? ' → ' : '–'}${fmtNum(v[1])}°`;
    return `${fmtNum(v[0])}${d.kind === 'span' ? ' → ' : '–'}${fmtNum(v[1])}${unit ? ` ${unit}` : ''}`;
  }
  if (typeof v === 'number') return `${fmtNum(v)}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (d.kind === 'enum') return d.options.find((o) => o.value === v)?.label ?? String(v);
  return String(v);
}

export function fmtNum(x: number): string {
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2);
}

export function formatValue(id: string, v: Value): string {
  const d = PARAM_BY_ID.get(id);
  return d ? fmt(d, v) : String(v);
}

/**
 * Resolves a world spec top-down (CONFIG.md §6): pinned values win, everything else is derived from
 * already-resolved parents. Runs in well under a millisecond, so the panel can call it while dragging.
 */
export function resolve(spec: WorldSpec): Resolved {
  const arch = archetypeById(spec.archetype);
  const values: Record<string, Value> = {};
  const autos: Record<string, Value> = {};
  const sources: Resolved['sources'] = {};
  const provenance: Record<string, string> = {};
  const drawn: Record<string, number> = {};

  let current: ParamDef | null = null;
  const read = (id: string): Value => {
    if (current && !current.deps.includes(id)) throw new Error(`${current.id}.auto reads undeclared dep ${id}`);
    const v = values[id];
    if (v === undefined) throw new Error(`${id} read before it was resolved`);
    return v;
  };
  const ctx: AutoCtx = {
    num: (id) => read(id) as number,
    range: (id) => read(id) as Range,
    mid: (id) => {
      const v = read(id);
      return Array.isArray(v) ? (v[0] + v[1]) / 2 : (v as number);
    },
    str: (id) => read(id) as string,
    bool: (id) => read(id) as boolean,
    bias: (key) => {
      const b = arch.bias[key];
      if (b === undefined) throw new Error(`unknown archetype bias ${key}`);
      return b;
    },
    archetype: arch.id,
  };

  for (const d of ORDER) {
    current = d;
    const auto = d.auto(ctx);
    current = null;
    autos[d.id] = auto;
    const userPin = d.readonly ? undefined : spec.pins[d.id];
    const presetPin = d.readonly ? undefined : arch.pins[d.id];
    if (isRangeParam(d)) {
      const m = mergeRangePins(userPin, presetPin);
      const { value } = combine(d, auto, m.pin, 'set');
      values[d.id] = value;
      sources[d.id] = m.src;
    } else {
      const fromPreset = userPin === undefined && presetPin !== undefined;
      const { value, source } = combine(d, auto, userPin ?? presetPin, fromPreset ? 'preset' : 'set');
      values[d.id] = value;
      sources[d.id] = source;
    }
    provenance[d.id] = d.deps.length
      ? `← ${d.deps.map((p) => `${PARAM_BY_ID.get(p)!.label.toLowerCase()} ${fmt(PARAM_BY_ID.get(p)!, values[p])}`).join(', ')}`
      : `← archetype ${arch.label}`;
    if (d.kind === 'draw') {
      const [lo, hi] = values[d.id] as Range;
      const u = rngFor(spec.seed, 'config', d.id).float();
      drawn[d.id] = d.integer ? lo + Math.floor(u * (hi - lo + 1)) : lo + u * (hi - lo);
    }
  }

  return { seed: spec.seed, archetype: arch.id, values, autos, sources, drawn, provenance, warnings: checkWarnings(values, drawn) };
}

/** Plausibility checks: pins always win, but the panel explains tensions (CONFIG.md §6). */
function checkWarnings(v: Record<string, Value>, drawn: Record<string, number>): Warning[] {
  const out: Warning[] = [];
  const size = v.worldSize as number;
  const land = size * size * (v.landFraction as number);
  const continents = drawn.continentCount;
  const perContinent = land / continents;
  if (perContinent < 5000) {
    out.push({
      ids: ['continentCount', 'landFraction', 'worldSize'],
      message: `Continents will be very small (≈ ${Math.round(perContinent).toLocaleString('en-US')} km² each).`,
    });
  }
  if (continents > drawn.plateCount + drawn.microplateCount) {
    out.push({ ids: ['continentCount', 'plateCount'], message: 'More continents than plates: several continents will share a plate.' });
  }
  if (drawn.mountainRangeCount > drawn.plateCount + drawn.microplateCount - 1 + 2) {
    out.push({ ids: ['mountainRangeCount', 'plateCount'], message: 'Few plate boundaries for this many ranges: some ranges will be short or intra-plate.' });
  }
  const peak = v.peakHeight as Range;
  if (peak[1] > 6000 && (v.tectonicActivity as number) < 0.25) {
    out.push({ ids: ['peakHeight', 'tectonicActivity'], message: 'Very high peaks on a quiet world: uplift will be concentrated in few ranges.' });
  }
  return out;
}

/** Copy of `spec` with one pin changed (`undefined` = back to AUTO / preset). */
export function withPin(spec: WorldSpec, id: string, pin: Pin | undefined): WorldSpec {
  const pins = { ...spec.pins };
  if (pin === undefined) delete pins[id];
  else pins[id] = pin;
  return { ...spec, pins };
}

/** Pins every parameter to its current resolved value ("Pin all"). */
export function pinAll(spec: WorldSpec): WorldSpec {
  const r = resolve(spec);
  const pins: Record<string, Pin> = {};
  for (const d of PARAMS) if (!d.readonly) pins[d.id] = (isRangeParam(d) ? [...(r.values[d.id] as Range)] : r.values[d.id]) as Pin;
  return { ...spec, pins };
}
