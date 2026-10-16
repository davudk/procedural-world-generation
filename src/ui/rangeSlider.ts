/**
 * Pointer- and keyboard-driven slider with one or two thumbs (CONFIG.md §7). Supports log scales,
 * step/integer snapping and a `span` mode where the thumbs are an ordered from → to pair that may
 * cross freely (e.g. latitude 65 → 20). Styling lives in panel.css under `.rs`.
 */

export interface SliderScale {
  min: number;
  max: number;
  step: number;
  log?: boolean | undefined;
  integer?: boolean | undefined;
}

export type ThumbState = 'auto' | 'preset' | 'set';
export type ThumbIndex = 0 | 1;
export type SliderPair = readonly [number, number];

export interface RangeSliderOptions extends SliderScale {
  /** 1 = single-value slider (values[1] mirrors values[0]); default 2. */
  thumbs?: 1 | 2 | undefined;
  /** Ordered from → to pair: thumbs cross freely and an arrow shows the direction. */
  span?: boolean | undefined;
  /** Accessible names of the thumbs. */
  labels?: readonly [string, string] | undefined;
  /** aria-valuetext formatter. */
  format?: ((v: number) => string) | undefined;
}

export interface RangeSliderDetail {
  thumb: ThumbIndex;
  values: SliderPair;
}

type Listener = (d: RangeSliderDetail) => void;
type EventKind = 'input' | 'change';

/** Thumb diameter in px; mirrored into CSS as `--rs-thumb` so hit-testing and layout agree. */
const THUMB_PX = 14;
/** Pointer travel (px) before a press on a thumb counts as a drag. */
const DRAG_SLOP_PX = 3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const usesLog = (s: SliderScale): boolean => s.log === true && s.min > 0 && s.max > s.min;

function stepDecimals(step: number): number {
  const str = String(step);
  const e = str.indexOf('e-');
  if (e >= 0) return Number(str.slice(e + 2));
  const dot = str.indexOf('.');
  return dot < 0 ? 0 : str.length - dot - 1;
}

/** Clamps to bounds and snaps to the step grid anchored at `min` (and to integers if requested). */
export function snapValue(v: number, s: SliderScale): number {
  let x = clamp(v, s.min, s.max);
  if (s.step > 0) x = s.min + Math.round((x - s.min) / s.step) * s.step;
  if (s.integer) x = Math.round(x);
  x = clamp(x, s.min, s.max);
  return Number(x.toFixed(stepDecimals(s.step)));
}

/** Value → track position in [0, 1] (logarithmic when `log` and min > 0). */
export function valueToPosition(v: number, s: SliderScale): number {
  if (s.max <= s.min) return 0;
  const c = clamp(v, s.min, s.max);
  if (usesLog(s)) return Math.log(c / s.min) / Math.log(s.max / s.min);
  return (c - s.min) / (s.max - s.min);
}

/** Track position in [0, 1] → snapped value. Inverse of `valueToPosition` up to snapping. */
export function positionToValue(t: number, s: SliderScale): number {
  const u = clamp(t, 0, 1);
  const raw = usesLog(s) ? s.min * (s.max / s.min) ** u : s.min + u * (s.max - s.min);
  return snapValue(raw, s);
}

/**
 * One keyboard step from `v`. Linear scales move by `step` (×10 when `big`); log scales move by 1 %
 * (10 %) of the track, so a key press feels the same at both ends. Always moves by at least one step
 * unless already at a bound.
 */
export function stepValue(v: number, dir: 1 | -1, big: boolean, s: SliderScale): number {
  if (usesLog(s)) {
    const next = positionToValue(valueToPosition(v, s) + dir * (big ? 0.1 : 0.01), s);
    return next !== v ? next : snapValue(v + dir * s.step, s);
  }
  return snapValue(v + dir * s.step * (big ? 10 : 1), s);
}

interface DragState {
  pointerId: number;
  /** null while two overlapping thumbs are pressed: decided by the first move direction. */
  thumb: ThumbIndex | null;
  startX: number;
  /** Position offset between the pointer and the grabbed thumb centre, so grabbing doesn't jump. */
  grab: number;
  onThumb: boolean;
  touch: boolean;
  moved: boolean;
  changed: boolean;
}

export class RangeSlider {
  readonly el: HTMLDivElement;
  private readonly opts: RangeSliderOptions;
  private readonly count: 1 | 2;
  private readonly thumbs: HTMLDivElement[] = [];
  private readonly fill: HTMLDivElement;
  private readonly arrow: HTMLSpanElement | null;
  private vals: [number, number];
  private readonly listeners: Record<EventKind, Set<Listener>> = { input: new Set(), change: new Set() };
  private drag: DragState | null = null;
  private keyPending: ThumbIndex | null = null;

  constructor(opts: RangeSliderOptions, initial: SliderPair = [opts.min, opts.max]) {
    this.opts = opts;
    this.count = opts.thumbs ?? 2;
    this.vals = [snapValue(initial[0], opts), snapValue(this.count === 1 ? initial[0] : initial[1], opts)];

    this.el = document.createElement('div');
    this.el.className = 'rs';
    this.el.style.setProperty('--rs-thumb', `${THUMB_PX}px`);
    if (opts.span) this.el.dataset.span = '';
    if (this.count === 1) this.el.dataset.single = '';

    const track = document.createElement('div');
    track.className = 'rs-track';
    this.fill = document.createElement('div');
    this.fill.className = 'rs-fill';
    track.append(this.fill);
    this.el.append(track);

    this.arrow = opts.span ? document.createElement('span') : null;
    if (this.arrow) {
      this.arrow.className = 'rs-arrow';
      this.arrow.setAttribute('aria-hidden', 'true');
      this.el.append(this.arrow);
    }

    for (let i = 0; i < this.count; i++) this.thumbs.push(this.makeThumb(i as ThumbIndex));
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.el.addEventListener('pointercancel', () => this.endDrag());
    this.el.addEventListener('lostpointercapture', () => this.endDrag());
    this.render();
  }

  get values(): SliderPair {
    return this.vals;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Sets values without emitting events (external updates; safe to call mid-drag). */
  setValues(values: SliderPair): void {
    const a = snapValue(values[0], this.opts);
    const b = this.count === 1 ? a : snapValue(values[1], this.opts);
    if (a === this.vals[0] && b === this.vals[1]) return;
    this.vals = [a, b];
    this.render();
  }

  setThumbStates(states: readonly [ThumbState, ThumbState]): void {
    this.thumbs.forEach((t, i) => (t.dataset.state = states[i]));
    const shown = states.slice(0, this.count);
    this.el.dataset.fill = shown.includes('set') ? 'set' : shown.includes('preset') ? 'preset' : 'auto';
  }

  /** Subscribes to live (`input`) or on-release (`change`) updates; returns an unsubscribe function. */
  on(kind: EventKind, fn: Listener): () => void {
    this.listeners[kind].add(fn);
    return () => this.listeners[kind].delete(fn);
  }

  // ── rendering ──────────────────────────────────────────────────────────────────────────────

  private makeThumb(i: ThumbIndex): HTMLDivElement {
    const t = document.createElement('div');
    t.className = 'rs-thumb';
    t.dataset.thumb = String(i);
    t.dataset.state = 'auto';
    t.tabIndex = 0;
    t.setAttribute('role', 'slider');
    t.setAttribute('aria-orientation', 'horizontal');
    t.setAttribute('aria-valuemin', String(this.opts.min));
    t.setAttribute('aria-valuemax', String(this.opts.max));
    const label = this.opts.labels?.[i] ?? (this.count === 1 ? 'value' : this.opts.span ? ['from', 'to'][i] : ['min', 'max'][i]);
    t.setAttribute('aria-label', label ?? 'value');
    t.addEventListener('keydown', (e) => this.onKeyDown(e, i));
    t.addEventListener('keyup', () => this.flushKey());
    t.addEventListener('blur', () => this.flushKey());
    this.el.append(t);
    return t;
  }

  private render(): void {
    const p = this.vals.map((v) => valueToPosition(v, this.opts));
    this.thumbs.forEach((t, i) => {
      t.style.setProperty('--p', String(p[i]));
      t.setAttribute('aria-valuenow', String(this.vals[i]));
      t.setAttribute('aria-valuetext', this.opts.format ? this.opts.format(this.vals[i]) : String(this.vals[i]));
    });
    const [a, b] = this.count === 1 ? [0, p[0]] : [Math.min(p[0], p[1]), Math.max(p[0], p[1])];
    this.el.style.setProperty('--a', String(a));
    this.el.style.setProperty('--b', String(b));
    if (this.arrow) {
      const dir = Math.sign(p[1] - p[0]);
      this.arrow.textContent = dir > 0 ? '→' : dir < 0 ? '←' : '';
      this.el.dataset.dir = dir < 0 ? 'rev' : 'fwd';
    }
  }

  private emit(kind: EventKind, thumb: ThumbIndex): void {
    const detail: RangeSliderDetail = { thumb, values: this.vals };
    for (const fn of this.listeners[kind]) fn(detail);
  }

  // ── value changes ──────────────────────────────────────────────────────────────────────────

  /** Moves one thumb; outside span mode it pushes the other thumb instead of crossing it. */
  private setThumb(i: ThumbIndex, v: number): boolean {
    const next: [number, number] = [...this.vals];
    next[i] = v;
    if (this.count === 1) next[1] = v;
    else if (!this.opts.span) {
      if (i === 0 && v > next[1]) next[1] = v;
      if (i === 1 && v < next[0]) next[0] = v;
    }
    if (next[0] === this.vals[0] && next[1] === this.vals[1]) return false;
    this.vals = next;
    this.render();
    this.raise(i);
    this.emit('input', i);
    return true;
  }

  private raise(i: ThumbIndex): void {
    this.thumbs.forEach((t, k) => t.classList.toggle('rs-top', k === i));
  }

  // ── keyboard ───────────────────────────────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent, i: ThumbIndex): void {
    const v = this.vals[i];
    const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown';
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
      case 'PageUp':
        next = stepValue(v, 1, big, this.opts);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
      case 'PageDown':
        next = stepValue(v, -1, big, this.opts);
        break;
      case 'Home':
        next = this.opts.min;
        break;
      case 'End':
        next = this.opts.max;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (this.setThumb(i, next)) this.keyPending = i;
  }

  private flushKey(): void {
    if (this.keyPending === null) return;
    const i = this.keyPending;
    this.keyPending = null;
    this.emit('change', i);
  }

  // ── pointer ────────────────────────────────────────────────────────────────────────────────

  private posFromX(clientX: number): number {
    const rect = this.el.getBoundingClientRect();
    const usable = rect.width - THUMB_PX;
    return usable > 0 ? (clientX - rect.left - THUMB_PX / 2) / usable : 0;
  }

  private thumbPos(i: ThumbIndex): number {
    return valueToPosition(this.vals[i], this.opts);
  }

  /** Nearest thumb to position `t`, or null when both thumbs sit (almost) on top of each other. */
  private pickThumb(t: number): ThumbIndex | null {
    if (this.count === 1) return 0;
    const width = this.el.getBoundingClientRect().width - THUMB_PX;
    const overlap = width > 0 ? THUMB_PX / 2 / width : 0;
    const d0 = Math.abs(t - this.thumbPos(0));
    const d1 = Math.abs(t - this.thumbPos(1));
    if (Math.abs(this.thumbPos(0) - this.thumbPos(1)) <= overlap && Math.min(d0, d1) <= overlap) return null;
    return d0 <= d1 ? 0 : 1;
  }

  /** For overlapping thumbs: the one that should move in direction `dx`. */
  private thumbForDirection(dx: number): ThumbIndex {
    const p0 = this.thumbPos(0);
    const p1 = this.thumbPos(1);
    if (p0 === p1) return dx > 0 ? 1 : 0;
    return (dx > 0) === p1 > p0 ? 1 : 0;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const t = this.posFromX(e.clientX);
    const target = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('.rs-thumb') : null;
    const onThumb = target !== null;
    let thumb = this.pickThumb(t);
    if (thumb === null && !onThumb) thumb = this.thumbForDirection(t - this.thumbPos(0));
    if (onThumb && thumb !== null) thumb = Number(target.dataset.thumb) as ThumbIndex;
    const touch = e.pointerType === 'touch';
    this.drag = {
      pointerId: e.pointerId,
      thumb,
      startX: e.clientX,
      grab: onThumb && thumb !== null ? t - this.thumbPos(thumb) : 0,
      onThumb,
      touch,
      moved: false,
      changed: false,
    };
    this.el.setPointerCapture(e.pointerId);
    if (!touch) e.preventDefault();
    if (thumb !== null) this.thumbs[thumb].focus({ preventScroll: true });
    // Mouse/pen click on the bare track jumps there at once; touch waits so a vertical scroll can win.
    if (!onThumb && !touch && thumb !== null) this.dragTo(thumb, t);
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
    d.moved = true;
    if (d.thumb === null) {
      d.thumb = this.thumbForDirection(dx);
      this.thumbs[d.thumb].focus({ preventScroll: true });
    }
    this.dragTo(d.thumb, this.posFromX(e.clientX) - d.grab);
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    // A touch tap on the track moves the nearest thumb there.
    if (!d.moved && !d.onThumb && d.touch) {
      const t = this.posFromX(e.clientX);
      this.dragTo(d.thumb ?? this.thumbForDirection(t - this.thumbPos(0)), t);
    }
    this.endDrag();
  }

  private dragTo(thumb: ThumbIndex, t: number): void {
    if (!this.drag) return;
    this.drag.thumb = thumb;
    if (this.setThumb(thumb, positionToValue(t, this.opts))) this.drag.changed = true;
  }

  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.el.hasPointerCapture(d.pointerId)) this.el.releasePointerCapture(d.pointerId);
    if (d.changed && d.thumb !== null) this.emit('change', d.thumb);
  }
}
