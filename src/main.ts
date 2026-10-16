import './style.css';
import { GenHost } from './app/genHost';
import { CameraController, isTypingTarget } from './input/cameraController';
import { Camera } from './render/camera2d';
import { RasterView, sampleLayer } from './render/rasterView';
import { fmtNum, resolve } from './shared/config/resolve';
import type { StageId, WorldSpec } from './shared/config/types';
import { queryToSpec, specToQuery } from './shared/config/url';
import type { FromWorker, GenMode, Layer } from './shared/protocol';
import { ConfigPanel } from './ui/configPanel';

/** Delay after the last settings change before a full-quality build starts. */
const BUILD_IDLE_MS = 900;
const LAYER_KEY = 'pwg.layer';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const seedInput = $<HTMLInputElement>('seed');
const progressEl = $('progress');
const layerSelect = $<HTMLSelectElement>('layer-select');
const legendEl = $('legend');
const inspectEl = $('inspect');

let spec: WorldSpec = queryToSpec(location.search, randomSeed());
const layers = new Map<string, Layer>();
let selected = readStored(LAYER_KEY) ?? 'elevation';
let fittedFor = -1;
let buildTimer = 0;
const stageEls = new Map<StageId, HTMLElement>();
/** Realised 🎯 targets of the current run; later stages refine earlier values. */
let outcomes: Record<string, number> = {};

const cam = new Camera();
const view = new RasterView(canvas);
const camCtl = new CameraController(canvas, cam, () => ({ w: currentWorldKm(), h: currentWorldKm() }));

const panel = new ConfigPanel($('panel'), spec, {
  onSpecChange(next, final) {
    spec = next;
    syncUrl();
    if (final) regenerate();
  },
});

const gen = new GenHost(onGenEvent);

seedInput.value = String(spec.seed);
seedInput.addEventListener('change', () => {
  const v = Number(seedInput.value.trim());
  if (!Number.isFinite(v)) {
    seedInput.value = String(spec.seed);
    return;
  }
  setSeed(Math.floor(Math.abs(v)) >>> 0);
});
$('dice').addEventListener('click', () => setSeed(randomSeed()));
$('build').addEventListener('click', () => startGen('build'));
$('panel-toggle').addEventListener('click', () => $('panel').classList.toggle('open'));
layerSelect.addEventListener('change', () => {
  selected = layerSelect.value;
  writeStored(LAYER_KEY, selected);
  showSelected();
});
window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey) return;
  if (e.code === 'KeyB') startGen('build');
  if (e.code === 'Home') fitView();
});
canvas.addEventListener('pointermove', (e) => inspect(e.offsetX, e.offsetY));
canvas.addEventListener('pointerleave', () => (inspectEl.textContent = ''));
canvas.addEventListener('dblclick', fitView);

syncUrl();
startGen('build');
requestAnimationFrame(frame);

// ── Generation ────────────────────────────────────────────────────────────────────────────

/** Settings changed: a fast preview now, a full build once the user pauses. */
function regenerate(): void {
  startGen('preview');
  clearTimeout(buildTimer);
  buildTimer = window.setTimeout(() => startGen('build'), BUILD_IDLE_MS);
}

function startGen(mode: GenMode): void {
  if (mode === 'build') clearTimeout(buildTimer);
  for (const el of stageEls.values()) el.className = 'stage';
  outcomes = {};
  gen.generate(resolve(spec), mode);
}

function onGenEvent(msg: FromWorker): void {
  switch (msg.type) {
    case 'stage-start':
      stageEl(msg.stage, msg.label).className = 'stage running';
      break;
    case 'stage-done': {
      const el = stageEl(msg.stage, msg.label);
      el.className = `stage ${msg.cached ? 'cached' : 'done'}`;
      el.textContent = `${msg.label} ${msg.cached ? 'cached' : `${Math.round(msg.ms)} ms`}`;
      el.title = Object.entries(msg.stats)
        .map(([k, v]) => `${k}: ${fmtNum(v)}`)
        .join('\n');
      for (const l of msg.layers) layers.set(l.id, l);
      outcomes = { ...outcomes, ...msg.outcomes };
      panel.setOutcomes(outcomes);
      refreshLayerList();
      showSelected();
      break;
    }
    case 'error':
      console.error(msg.message);
      progressEl.insertAdjacentHTML('beforeend', '<span class="stage error">error (see console)</span>');
      break;
    case 'done':
    case 'cancelled':
      break;
  }
}

function stageEl(id: StageId, label: string): HTMLElement {
  let el = stageEls.get(id);
  if (!el) {
    el = document.createElement('span');
    progressEl.append(el);
    stageEls.set(id, el);
  }
  el.textContent = label;
  return el;
}

// ── Layers, legend, inspector ─────────────────────────────────────────────────────────────

function refreshLayerList(): void {
  const ids = [...layers.keys()];
  if (layerSelect.options.length === ids.length) return;
  layerSelect.replaceChildren(
    ...ids.map((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `${layers.get(id)!.label}  (${layers.get(id)!.stage})`;
      return o;
    }),
  );
  layerSelect.value = shownLayerId();
}

/** The chosen layer, or the latest one while the chosen layer hasn't been generated yet. */
function shownLayerId(): string {
  return layers.has(selected) ? selected : ([...layers.keys()].at(-1) ?? selected);
}

function showSelected(): void {
  layerSelect.value = shownLayerId();
  const l = layers.get(shownLayerId());
  if (!l) return;
  view.setLayer(l);
  if (fittedFor !== l.worldKm) {
    fittedFor = l.worldKm;
    fitView();
  }
  const cell = (l.worldKm / l.w).toFixed(2);
  legendEl.textContent =
    l.kind === 'categorical'
      ? `${l.w}² cells · ${cell} km/cell · ${l.max + 1} classes`
      : `${l.w}² cells · ${cell} km/cell · ${fmtNum(l.min)} … ${fmtNum(l.max)} ${l.unit}`;
}

function inspect(sx: number, sy: number): void {
  const x = cam.screenToWorldX(sx);
  const y = cam.screenToWorldY(sy);
  const l = layers.get(shownLayerId());
  const elev = layers.get('elevation');
  if (!l) return;
  const v = sampleLayer(l, x, y);
  if (v === null) {
    inspectEl.textContent = '';
    return;
  }
  const lines = [`${x.toFixed(1)} km, ${y.toFixed(1)} km`, `${l.label}: ${fmtNum(v)} ${l.unit}`];
  if (elev && elev !== l) lines.push(`Elevation: ${fmtNum(sampleLayer(elev, x, y) ?? 0)} m`);
  inspectEl.textContent = lines.join('\n');
}

function fitView(): void {
  view.resize(cam);
  const panelEl = $('panel');
  const docked = getComputedStyle(panelEl).transform === 'none' || window.innerWidth > 760;
  const top = $('topbar').getBoundingClientRect().bottom;
  cam.fit(currentWorldKm(), currentWorldKm(), { top, right: docked ? window.innerWidth - panelEl.getBoundingClientRect().left : 0, bottom: 0, left: 0 });
  camCtl.setZoom(cam.zoom);
}

function currentWorldKm(): number {
  return layers.get(shownLayerId())?.worldKm ?? 1024;
}

// ── Frame loop ────────────────────────────────────────────────────────────────────────────

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  view.resize(cam);
  camCtl.update(dt);
  view.draw(cam);
  requestAnimationFrame(frame);
}

// ── Seed & URL ────────────────────────────────────────────────────────────────────────────

function setSeed(seed: number): void {
  spec = { ...spec, seed };
  seedInput.value = String(seed);
  panel.setSpec(spec);
  syncUrl();
  startGen('build');
}

function syncUrl(): void {
  history.replaceState(null, '', `${location.pathname}?${specToQuery(spec)}`);
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1e9);
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode); the selection just isn't remembered.
  }
}
