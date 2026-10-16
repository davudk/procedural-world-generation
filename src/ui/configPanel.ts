import './panel.css';
import { ARCHETYPES, archetypeById } from '../shared/config/archetypes';
import { fmtNum, formatValue, pinAll, resolve, withPin } from '../shared/config/resolve';
import { PARAMS, SECTION_LABELS } from '../shared/config/schema';
import {
  AUTO_PIN,
  isRangeParam,
  type EnumParam,
  type NumberParam,
  type ParamDef,
  type Pin,
  type Range,
  type RangeParam,
  type Resolved,
  type Section,
  type Source,
  type ToggleParam,
  type Value,
  type WorldSpec,
} from '../shared/config/types';
import { RangeSlider, type RangeSliderDetail, type SliderScale } from './rangeSlider';

/**
 * The world configuration panel (CONFIG.md §7). DOM is built once; every edit re-resolves the spec
 * and updates all rows in place, so AUTO children visibly follow a dragged parent.
 */

export interface PanelCallbacks {
  /** Called with the new spec on every user edit. `final` is false while dragging, true on release/commit. */
  onSpecChange(spec: WorldSpec, final: boolean): void;
}

type AnySource = Source | readonly [Source, Source];

const COLLAPSED_KEY = 'pwg.configPanel.collapsed';
const DEFAULT_COLLAPSED: readonly Section[] = ['advanced'];
/** Relative tolerance for 🎯 scalar targets (ranges use their bounds). */
const SCALAR_TARGET_TOLERANCE = 0.1;

const SOURCE_LABEL: Readonly<Record<Source, string>> = { auto: 'AUTO', preset: 'PRESET', set: 'SET' };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setTitle(el: HTMLElement, text: string): void {
  if (el.title !== text) el.title = text;
}

function sourcePair(src: AnySource | undefined): readonly [Source, Source] {
  if (Array.isArray(src)) return src as readonly [Source, Source];
  const s = (src as Source | undefined) ?? 'auto';
  return [s, s];
}

/** Overall chip state: SET if any thumb is user-pinned, else PRESET if any is preset, else AUTO. */
function chipState(src: AnySource | undefined): { state: Source; partial: boolean } {
  const [a, b] = sourcePair(src);
  const state: Source = a === 'set' || b === 'set' ? 'set' : a === 'preset' || b === 'preset' ? 'preset' : 'auto';
  return { state, partial: a !== b };
}

function valueToPin(v: Value): Pin {
  return Array.isArray(v) ? ([v[0], v[1]] as const) : (v as Exclude<Value, Range>);
}

function valueKey(v: Value | undefined): string {
  return Array.isArray(v) ? `${v[0]},${v[1]}` : String(v);
}

function loadCollapsed(): Set<Section> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.filter((s): s is Section => typeof s === 'string' && s in SECTION_LABELS));
    }
  } catch {
    // Storage unavailable (private mode, blocked): fall back to defaults.
  }
  return new Set(DEFAULT_COLLAPSED);
}

function saveCollapsed(collapsed: ReadonlySet<Section>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Not persisted; harmless.
  }
}

/** Whether a realised 🎯 outcome satisfies the resolved value. */
function outcomeOk(target: Value | undefined, got: number): boolean {
  if (Array.isArray(target)) return got >= Math.min(target[0], target[1]) && got <= Math.max(target[0], target[1]);
  if (typeof target === 'number') return Math.abs(got - target) <= SCALAR_TARGET_TOLERANCE * Math.max(Math.abs(target), 1e-9);
  return true;
}

// ── Row controls ─────────────────────────────────────────────────────────────────────────────

/** What a row needs from the panel. */
interface RowHost {
  readonly spec: WorldSpec;
  readonly resolved: Resolved;
  setPin(id: string, pin: Pin | undefined, final: boolean): void;
}

interface Control {
  readonly el: HTMLElement;
  /** Inline controls sit on the label line (select, checkbox); others get their own line. */
  readonly inline: boolean;
  update(value: Value, src: AnySource | undefined): void;
}

function scaleOf(def: NumberParam | RangeParam): SliderScale {
  return { min: def.min, max: def.max, step: def.step, log: def.log, integer: def.integer };
}

function numberControl(def: NumberParam, host: RowHost): Control {
  const slider = new RangeSlider({ ...scaleOf(def), thumbs: 1, labels: [def.label, def.label], format: (v) => formatValue(def.id, v) });
  const commit = (d: RangeSliderDetail, final: boolean): void => host.setPin(def.id, d.values[0], final);
  slider.on('input', (d) => commit(d, false));
  slider.on('change', (d) => commit(d, true));
  return {
    el: slider.el,
    inline: false,
    update(value, src) {
      slider.setValues([value as number, value as number]);
      const s = sourcePair(src)[0];
      slider.setThumbStates([s, s]);
    },
  };
}

/**
 * A range pin after moving one thumb: the moved thumb is pinned; the other keeps its user pin or is left
 * `null`, so it stays AUTO or PRESET (`resolve` merges user and archetype pins per thumb).
 */
function rangePinAfterMove(host: RowHost, id: string, d: RangeSliderDetail): Pin {
  const src = sourcePair(host.resolved.sources[id]);
  const pick = (i: 0 | 1): number | null => (i === d.thumb || src[i] === 'set' ? d.values[i] : null);
  return [pick(0), pick(1)];
}

function rangeControl(def: RangeParam, host: RowHost): Control {
  const labels: readonly [string, string] =
    def.kind === 'span' ? [`${def.label} from`, `${def.label} to`] : [`${def.label} min`, `${def.label} max`];
  const slider = new RangeSlider({
    ...scaleOf(def),
    span: def.kind === 'span',
    labels,
    format: (v) => formatValue(def.id, v),
  });
  const commit = (d: RangeSliderDetail, final: boolean): void => host.setPin(def.id, rangePinAfterMove(host, def.id, d), final);
  slider.on('input', (d) => commit(d, false));
  slider.on('change', (d) => commit(d, true));
  return {
    el: slider.el,
    inline: false,
    update(value, src) {
      slider.setValues(value as Range);
      slider.setThumbStates(sourcePair(src));
    },
  };
}

function enumControl(def: EnumParam, host: RowHost): Control {
  const select = h('select', 'pp-select');
  select.setAttribute('aria-label', def.label);
  for (const o of def.options) {
    const opt = h('option', '', o.label);
    opt.value = o.value;
    select.append(opt);
  }
  select.addEventListener('change', () => host.setPin(def.id, select.value, true));
  return {
    el: select,
    inline: true,
    update(value, src) {
      if (select.value !== value) select.value = value as string;
      select.dataset.state = sourcePair(src)[0];
    },
  };
}

function toggleControl(def: ToggleParam, host: RowHost): Control {
  const box = h('input', 'pp-check');
  box.type = 'checkbox';
  box.setAttribute('aria-label', def.label);
  box.addEventListener('change', () => host.setPin(def.id, box.checked, true));
  return {
    el: box,
    inline: true,
    update(value, src) {
      box.checked = value === true;
      box.dataset.state = sourcePair(src)[0];
    },
  };
}

function makeControl(def: ParamDef, host: RowHost): Control | null {
  if (def.readonly) return null;
  if (isRangeParam(def)) return rangeControl(def, host);
  switch (def.kind) {
    case 'number':
      return numberControl(def, host);
    case 'enum':
      return enumControl(def, host);
    case 'toggle':
      return toggleControl(def, host);
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

interface RowView {
  resolved: Resolved;
  pinned: boolean;
  warnings: readonly string[];
  outcome: number | undefined;
  outcomeStale: boolean;
}

class ParamRow {
  readonly el: HTMLDivElement;
  readonly def: ParamDef;
  private readonly host: RowHost;
  private readonly control: Control | null;
  private readonly labelEl = h('span', 'pp-label');
  private readonly valueEl = h('span', 'pp-value');
  private readonly warnEl = h('span', 'pp-warn', '⚠');
  private readonly chipEl = h('button', 'pp-chip');
  private readonly resetEl = h('button', 'pp-reset', '↺');
  private readonly drewEl = h('span', 'pp-drew');
  private readonly outcomeEl = h('span', 'pp-outcome');
  private readonly searchText: string;
  private lastKey: string | null = null;

  constructor(def: ParamDef, host: RowHost) {
    this.def = def;
    this.host = host;
    this.control = makeControl(def, host);
    this.searchText = `${def.label} ${def.id} ${def.help}`.toLowerCase();
    this.el = h('div', 'pp-row');
    this.el.dataset.id = def.id;
    this.el.dataset.kind = def.kind;
    if (def.readonly) this.el.dataset.readonly = '';
    this.el.addEventListener('animationend', () => this.el.classList.remove('pp-flash'));
    this.build();
  }

  private build(): void {
    const { def } = this;
    this.labelEl.textContent = def.label;
    if (def.target) this.labelEl.append(h('span', 'pp-target', ' 🎯'));
    const head = h('div', 'pp-row-head');
    head.append(this.labelEl);
    if (this.control?.inline) head.append(this.control.el);
    else head.append(this.valueEl);
    this.warnEl.hidden = true;
    head.append(this.warnEl);
    if (!def.readonly) {
      this.chipEl.type = 'button';
      this.chipEl.addEventListener('click', () => this.onChipClick());
      this.resetEl.type = 'button';
      this.resetEl.setAttribute('aria-label', `Reset ${def.label}`);
      this.resetEl.addEventListener('click', () => this.host.setPin(def.id, undefined, true));
      head.append(this.chipEl, this.resetEl);
    }
    this.el.append(head);
    if (this.control && !this.control.inline) {
      const line = h('div', 'pp-row-ctrl');
      line.append(this.control.el);
      this.el.append(line);
    }
    if (def.kind === 'draw' || def.target) {
      const note = h('div', 'pp-row-note');
      note.append(this.drewEl, this.outcomeEl);
      this.el.append(note);
    }
  }

  matches(query: string): boolean {
    return query === '' || this.searchText.includes(query);
  }

  /** Updates the row in place; returns true if the displayed value changed since the last render. */
  render(v: RowView): boolean {
    const { def } = this;
    const value = v.resolved.values[def.id];
    const src = v.resolved.sources[def.id];
    const { state, partial } = chipState(src);
    this.el.dataset.state = state;

    this.control?.update(value as Value, src);
    setText(this.valueEl, value === undefined ? '' : formatValue(def.id, value));
    this.renderChip(state, partial, src);
    this.resetEl.hidden = !v.pinned;
    this.renderWarnings(v.warnings);
    this.renderNotes(v);
    const tip = this.tooltip(v.resolved, state);
    setTitle(this.labelEl, tip);
    setTitle(this.valueEl, tip);

    const key = valueKey(value);
    const changed = this.lastKey !== null && key !== this.lastKey;
    this.lastKey = key;
    return changed;
  }

  flash(): void {
    this.el.classList.remove('pp-flash');
    void this.el.offsetWidth; // restart the animation
    this.el.classList.add('pp-flash');
  }

  private renderChip(state: Source, partial: boolean, src: AnySource | undefined): void {
    if (this.def.readonly) return;
    setText(this.chipEl, SOURCE_LABEL[state]);
    this.chipEl.dataset.state = state;
    this.chipEl.classList.toggle('pp-partial', partial);
    const parts = isRangeParam(this.def)
      ? sourcePair(src)
          .map((s, i) => `${(this.def.kind === 'span' ? ['from', 'to'] : ['min', 'max'])[i]}: ${SOURCE_LABEL[s]}`)
          .join(' · ')
      : SOURCE_LABEL[state];
    const action =
      state === 'auto' ? 'Click to pin the current value.' : state === 'set' ? 'Click to return to AUTO.' : 'Set by the archetype. Click to use AUTO instead; ↺ restores the preset.';
    setTitle(this.chipEl, `${parts}\n${action}`);
  }

  private renderWarnings(messages: readonly string[]): void {
    this.warnEl.hidden = messages.length === 0;
    setTitle(this.warnEl, messages.join('\n'));
  }

  private renderNotes(v: RowView): void {
    const drawn = v.resolved.drawn[this.def.id];
    setText(this.drewEl, this.def.kind === 'draw' && drawn !== undefined ? `drew ${fmtNum(drawn)}` : '');
    if (v.outcome === undefined || !this.def.target) {
      setText(this.outcomeEl, '');
      return;
    }
    const ok = outcomeOk(v.resolved.values[this.def.id], v.outcome);
    setText(this.outcomeEl, `→ got ${fmtNum(v.outcome)} ${ok ? '✓' : '⚠'}`);
    this.outcomeEl.dataset.ok = String(ok);
    this.outcomeEl.classList.toggle('pp-stale', v.outcomeStale);
    setTitle(this.outcomeEl, v.outcomeStale ? 'From the last generated world; settings have changed since.' : 'Realised in the generated world.');
  }

  private tooltip(r: Resolved, state: Source): string {
    const { def } = this;
    const lines = [def.help];
    const prov = r.provenance[def.id];
    if (prov) lines.push(`AUTO ${prov}`);
    const auto = r.autos[def.id];
    if (state !== 'auto' && auto !== undefined) lines.push(`${SOURCE_LABEL[state]}; auto would be ${formatValue(def.id, auto)}`);
    lines.push(`id: ${def.id}`);
    return lines.join('\n');
  }

  private onChipClick(): void {
    const { state } = chipState(this.host.resolved.sources[this.def.id]);
    if (state === 'auto') {
      const v = this.host.resolved.values[this.def.id];
      if (v !== undefined) this.host.setPin(this.def.id, valueToPin(v), true);
    } else if (state === 'set') {
      this.host.setPin(this.def.id, undefined, true);
    } else {
      this.host.setPin(this.def.id, AUTO_PIN, true);
    }
  }
}

// ── Sections ─────────────────────────────────────────────────────────────────────────────────

class SectionView {
  readonly el: HTMLElement;
  readonly rows: ParamRow[] = [];
  private readonly head = h('button', 'pp-section-head');
  private readonly countEl = h('span', 'pp-section-count');
  private readonly body = h('div', 'pp-section-body');

  constructor(
    readonly id: Section,
    collapsed: boolean,
    onToggle: (id: Section, collapsed: boolean) => void,
  ) {
    this.el = h('section', 'pp-section');
    this.el.dataset.section = id;
    this.head.type = 'button';
    this.head.append(h('span', 'pp-caret', '▸'), h('span', 'pp-section-title', SECTION_LABELS[id]), this.countEl);
    this.head.addEventListener('click', () => {
      const next = !this.collapsed;
      this.setCollapsed(next);
      onToggle(id, next);
    });
    this.body.id = `pp-section-${id}`;
    this.head.setAttribute('aria-controls', this.body.id);
    this.el.append(this.head, this.body);
    this.setCollapsed(collapsed);
  }

  get collapsed(): boolean {
    return this.el.classList.contains('pp-collapsed');
  }

  setCollapsed(c: boolean): void {
    this.el.classList.toggle('pp-collapsed', c);
    this.head.setAttribute('aria-expanded', String(!c));
  }

  add(row: ParamRow): void {
    this.rows.push(row);
    this.body.append(row.el);
  }

  setPinnedCount(n: number): void {
    setText(this.countEl, n > 0 ? `${n} set` : '');
  }

  /** Hides non-matching rows; returns whether any row matched. */
  filter(query: string): boolean {
    let any = false;
    for (const row of this.rows) {
      const m = row.matches(query);
      row.el.hidden = !m;
      any ||= m;
    }
    this.el.hidden = !any;
    return any;
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────────────────────

export class ConfigPanel {
  private specValue: WorldSpec;
  private resolvedValue: Resolved;
  private outcomes: Readonly<Record<string, number>> = {};
  private outcomesStale = false;
  private readonly cb: PanelCallbacks;
  private readonly rootEl = h('div', 'pp-root');
  private readonly archetypeEl = h('select', 'pp-select pp-archetype');
  private readonly resetAllEl = h('button', 'pp-btn', 'Reset all');
  private readonly pinAllEl = h('button', 'pp-btn', 'Pin all');
  private readonly searchEl = h('input', 'pp-search');
  private readonly warningsEl = h('ul', 'pp-warnings');
  private warningsKey = '';
  private readonly sections: SectionView[] = [];
  private readonly rows = new Map<string, ParamRow>();

  constructor(root: HTMLElement, spec: WorldSpec, cb: PanelCallbacks) {
    this.specValue = spec;
    this.resolvedValue = resolve(spec);
    this.cb = cb;
    this.rootEl.append(this.buildHeader(), this.buildBody());
    root.append(this.rootEl);
    this.render(null);
  }

  /** External spec change (seed dice, URL load). Re-renders values without rebuilding DOM. */
  setSpec(spec: WorldSpec): void {
    this.specValue = spec;
    this.resolvedValue = resolve(spec);
    this.outcomesStale = true;
    this.render(null);
  }

  /** Realised values reported after generation, keyed by param id (for 🎯 target params), e.g. { continentCount: 2 }. */
  setOutcomes(outcomes: Readonly<Record<string, number>>): void {
    this.outcomes = outcomes;
    this.outcomesStale = false;
    this.render(null);
  }

  // ── building ───────────────────────────────────────────────────────────────────────────────

  private buildHeader(): HTMLElement {
    const header = h('div', 'pp-header');
    this.archetypeEl.setAttribute('aria-label', 'Archetype');
    for (const a of ARCHETYPES) {
      const opt = h('option', '', a.label);
      opt.value = a.id;
      opt.title = a.blurb;
      this.archetypeEl.append(opt);
    }
    this.archetypeEl.addEventListener('change', () => this.edit({ ...this.specValue, archetype: this.archetypeEl.value }, true, null));

    this.resetAllEl.type = 'button';
    this.resetAllEl.title = 'Clear all your pins (archetype presets stay).';
    this.resetAllEl.addEventListener('click', () => this.edit({ ...this.specValue, pins: {} }, true, null));
    this.pinAllEl.type = 'button';
    this.pinAllEl.title = 'Pin every value as it is now, freezing the world against formula changes.';
    this.pinAllEl.addEventListener('click', () => this.edit(pinAll(this.specValue), true, null));

    this.searchEl.type = 'search';
    this.searchEl.placeholder = 'Search parameters…';
    this.searchEl.setAttribute('aria-label', 'Search parameters');
    this.searchEl.addEventListener('input', () => this.applySearch());

    const line = h('div', 'pp-head-line');
    line.append(this.archetypeEl, this.resetAllEl, this.pinAllEl);
    header.append(line, this.searchEl, this.warningsEl);
    return header;
  }

  private buildBody(): HTMLElement {
    const body = h('div', 'pp-body');
    const collapsed = loadCollapsed();
    const onToggle = (id: Section, c: boolean): void => {
      if (c) collapsed.add(id);
      else collapsed.delete(id);
      saveCollapsed(collapsed);
    };
    const host = this.host();
    for (const id of Object.keys(SECTION_LABELS) as Section[]) {
      const section = new SectionView(id, collapsed.has(id), onToggle);
      for (const def of PARAMS) {
        if (def.section !== id) continue;
        const row = new ParamRow(def, host);
        this.rows.set(def.id, row);
        section.add(row);
      }
      if (section.rows.length === 0) continue;
      this.sections.push(section);
      body.append(section.el);
    }
    return body;
  }

  private host(): RowHost {
    // Getters, so rows always see the latest spec and resolution.
    const panel = this;
    return {
      get spec() {
        return panel.specValue;
      },
      get resolved() {
        return panel.resolvedValue;
      },
      setPin(id, pin, final) {
        panel.edit(withPin(panel.specValue, id, pin), final, id);
      },
    };
  }

  // ── updates ────────────────────────────────────────────────────────────────────────────────

  private edit(spec: WorldSpec, final: boolean, sourceId: string | null): void {
    this.specValue = spec;
    this.resolvedValue = resolve(spec);
    this.outcomesStale = true;
    this.render(sourceId ?? '');
    this.cb.onSpecChange(spec, final);
  }

  /**
   * Re-renders every row in place. `flashExcept` null = no flash (external update); otherwise rows
   * whose value changed flash, except the edited one.
   */
  private render(flashExcept: string | null): void {
    const r = this.resolvedValue;
    this.renderHeader();
    const warnByRow = this.renderWarnings(r);
    for (const row of this.rows.values()) {
      const id = row.def.id;
      const changed = row.render({
        resolved: r,
        pinned: this.specValue.pins[id] !== undefined,
        warnings: warnByRow.get(id) ?? [],
        outcome: this.outcomes[id],
        outcomeStale: this.outcomesStale,
      });
      if (changed && flashExcept !== null && id !== flashExcept) row.flash();
    }
    for (const s of this.sections) s.setPinnedCount(s.rows.filter((row) => this.specValue.pins[row.def.id] !== undefined).length);
  }

  private renderHeader(): void {
    const spec = this.specValue;
    const custom = Object.keys(spec.pins).length > 0;
    const current = archetypeById(spec.archetype);
    if (this.archetypeEl.value !== current.id) this.archetypeEl.value = current.id;
    for (const opt of this.archetypeEl.options) {
      const a = archetypeById(opt.value);
      setText(opt, custom && a.id === current.id ? `Custom (based on ${a.label})` : a.label);
    }
    setTitle(this.archetypeEl, current.blurb);
    this.resetAllEl.disabled = !custom;
  }

  /** Rebuilds the top warning list only when its content changes; returns messages per row id. */
  private renderWarnings(r: Resolved): Map<string, string[]> {
    const byRow = new Map<string, string[]>();
    for (const w of r.warnings) {
      for (const id of w.ids) byRow.set(id, [...(byRow.get(id) ?? []), w.message]);
    }
    const key = r.warnings.map((w) => `${w.ids.join(',')}:${w.message}`).join('\n');
    if (key !== this.warningsKey) {
      this.warningsKey = key;
      this.warningsEl.replaceChildren(...r.warnings.map((w) => this.warningItem(w.ids, w.message)));
    }
    this.warningsEl.hidden = r.warnings.length === 0;
    return byRow;
  }

  private warningItem(ids: readonly string[], message: string): HTMLLIElement {
    const li = h('li', 'pp-warning');
    const btn = h('button', 'pp-warning-btn', `⚠ ${message}`);
    btn.type = 'button';
    btn.title = 'Show the parameters involved';
    btn.addEventListener('click', () => this.reveal(ids));
    li.append(btn);
    return li;
  }

  /** Expands the sections of `ids`, scrolls to the first and flashes them. */
  private reveal(ids: readonly string[]): void {
    const rows = ids.map((id) => this.rows.get(id)).filter((r): r is ParamRow => r !== undefined);
    for (const row of rows) {
      const section = this.sections.find((s) => s.rows.includes(row));
      if (section?.collapsed) section.setCollapsed(false);
      row.flash();
    }
    rows[0]?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private applySearch(): void {
    const q = this.searchEl.value.trim().toLowerCase();
    this.rootEl.classList.toggle('pp-searching', q !== '');
    for (const s of this.sections) s.filter(q);
  }
}
