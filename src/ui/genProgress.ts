import './genProgress.css';
import { SPHERE_STAGES, type StageId, type WorldShape } from '../shared/config/types';
import type { GenMode } from '../shared/protocol';

/** Pipeline order and names (mirrors `src/gen/stages/index.ts`; events override the labels). */
const STEPS: readonly [StageId, string][] = [
  ['plates', 'Plates'], ['base', 'Base elevation'], ['stamps', 'Volcanoes & craters'], ['lem', 'Erosion'], ['refine', 'Refine'],
  ['climate', 'Climate'], ['glacial', 'Glaciers & fjords'], ['landforms', 'Landforms'], ['hydro', 'Rivers & lakes'],
  ['biome', 'Biomes'], ['registry', 'Landmarks & names'],
];

/** Typical build times (ms) used as segment widths until a run has been measured. */
const DEFAULT_MS: Partial<Record<StageId, number>> = {
  plates: 60, base: 300, stamps: 40, lem: 2300, refine: 2600, climate: 230, glacial: 220, landforms: 310, hydro: 570, biome: 110, registry: 220,
};

type StepState = 'pending' | 'running' | 'done' | 'cached';

/**
 * Generation timeline under the top bar: one segment per pipeline stage, sized by its expected
 * duration (last measured run per mode), plus a short status ("Erosion · 4 of 11"). The running
 * segment fills over its expected time. The bar fades out shortly after the world is ready. Spherical
 * worlds run the stages listed in SPHERE_STAGES; the others are hidden.
 */
export class GenProgress {
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly segs = new Map<StageId, HTMLElement>();
  private readonly labels = new Map<StageId, string>(STEPS);
  private readonly state = new Map<StageId, StepState>();
  private readonly measured: Record<GenMode, Partial<Record<StageId, number>>> = { preview: {}, build: {} };
  private mode: GenMode = 'build';
  private steps: readonly (readonly [StageId, string])[] = STEPS;
  private hideTimer = 0;

  constructor(statusHost: HTMLElement, barHost: HTMLElement) {
    this.status = statusHost;
    this.status.classList.add('gen-status');
    this.bar = document.createElement('div');
    this.bar.className = 'gen-bar';
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-label', 'World generation progress');
    this.bar.setAttribute('aria-valuemin', '0');
    for (const [id] of STEPS) {
      const s = document.createElement('div');
      s.className = 'gen-seg';
      s.append(document.createElement('i'));
      this.bar.append(s);
      this.segs.set(id, s);
    }
    this.bar.setAttribute('aria-valuemax', String(STEPS.length));
    barHost.append(this.bar);
  }

  start(mode: GenMode, shape: WorldShape = 'flat'): void {
    this.mode = mode;
    this.steps = shape === 'sphere' ? STEPS.filter(([id]) => SPHERE_STAGES.includes(id)) : STEPS;
    for (const [id, seg] of this.segs) seg.style.display = this.steps.some(([s]) => s === id) ? '' : 'none';
    this.bar.setAttribute('aria-valuemax', String(this.steps.length));
    clearTimeout(this.hideTimer);
    this.bar.classList.remove('finished', 'failed');
    this.status.classList.remove('finished', 'failed');
    for (const [id] of this.steps) this.state.set(id, 'pending');
    this.layout();
    this.render();
  }

  stageStart(id: StageId, label: string): void {
    this.labels.set(id, label);
    this.state.set(id, 'running');
    this.render();
  }

  /** `tooltip` lists the stage's stats; timings stay out of the visible UI. */
  stageDone(id: StageId, label: string, ms: number, cached: boolean, tooltip: string): void {
    this.labels.set(id, label);
    this.state.set(id, cached ? 'cached' : 'done');
    if (!cached) this.measured[this.mode][id] = Math.max(1, ms);
    const seg = this.segs.get(id);
    if (seg) seg.title = tooltip ? `${label}\n${tooltip}` : label;
    this.render();
  }

  finish(): void {
    for (const [id] of this.steps) if (this.state.get(id) !== 'cached') this.state.set(id, 'done');
    this.render();
    this.bar.classList.add('finished');
    this.status.classList.add('finished');
    this.hideTimer = window.setTimeout(() => this.status.classList.add('faded'), 2500);
  }

  fail(): void {
    this.bar.classList.add('failed');
    this.status.classList.add('failed');
    this.status.textContent = 'Generation failed (see console)';
  }

  /** Segment widths from the expected time of each stage in this mode. */
  private layout(): void {
    const m = this.measured[this.mode];
    const scale = this.mode === 'preview' ? 0.25 : 1;
    for (const [id] of this.steps) {
      const ms = m[id] ?? (DEFAULT_MS[id] ?? 100) * scale;
      const seg = this.segs.get(id)!;
      seg.style.flexGrow = String(Math.max(ms, 40));
      // The running fill eases to 90 % over the expected time, so a slow stage never looks finished.
      seg.style.setProperty('--expected', `${Math.round(ms)}ms`);
    }
  }

  private render(): void {
    let finished = 0;
    let running: StageId | null = null;
    for (const [id] of this.steps) {
      const st = this.state.get(id) ?? 'pending';
      this.segs.get(id)!.className = `gen-seg ${st}`;
      if (st === 'done' || st === 'cached') finished++;
      if (st === 'running') running = id;
    }
    this.bar.setAttribute('aria-valuenow', String(finished));
    this.status.classList.remove('faded');
    const total = this.steps.length;
    const what = this.mode === 'preview' ? 'Preview' : 'Building';
    if (finished === total) this.status.textContent = this.mode === 'preview' ? 'Preview ready' : 'World ready';
    else if (running) this.status.textContent = `${what} · ${this.labels.get(running)} · ${finished + 1} of ${total}`;
    else this.status.textContent = `${what} · ${finished} of ${total}`;
  }
}
