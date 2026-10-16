import './style.css';
import { GenHost } from './app/genHost';
import { CameraController, isTypingTarget } from './input/cameraController';
import { OrbitController } from './input/orbitController';
import { worldToMapKm } from './render/camera/ground';
import { Camera } from './render/camera2d';
import { Minimap } from './render/minimap';
import { RasterView, sampleLayer } from './render/rasterView';
import { WorldView } from './render/worldView';
import { fmtNum, resolve } from './shared/config/resolve';
import type { StageId, WorldSpec } from './shared/config/types';
import { queryToSpec, specToQuery } from './shared/config/url';
import type { Landmark } from './shared/landmarks';
import type { FromWorker, GenMode, Layer, RiverGraph } from './shared/protocol';
import { AtlasPanel, KIND_LABEL } from './ui/atlas';
import { Compass } from './ui/compass';
import { ConfigPanel } from './ui/configPanel';

/** Delay after the last settings change before a full-quality build starts. */
const BUILD_IDLE_MS = 900;
const LAYER_KEY = 'pwg.layer';
const MODE_KEY = 'pwg.mode';
const PALETTE_KEY = 'pwg.palette';

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
let rivers: RiverGraph | null = null;
let landmarks: Landmark[] = [];
/** Realised 🎯 targets of the current run; later stages refine earlier values. */
let outcomes: Record<string, number> = {};

// The 3D world creates the WebGL2 context; the 2D raster view shares it.
const world = new WorldView(canvas);
const orbit = new OrbitController(canvas, world.cam);
const minimap = new Minimap($('layers'), world.cam);
const compass = new Compass($('compass-host'), world.cam);
const cam = new Camera();
const view = new RasterView(canvas);
const camCtl = new CameraController(canvas, cam, () => ({ w: currentWorldKm(), h: currentWorldKm() }));
/** Debug handle for the console / browser automation. */
Object.assign(window, { __pwg: { world, orbit, layers: () => layers } });
let mode: '3d' | '2d' = readStored(MODE_KEY) === '2d' ? '2d' : '3d';
let terrainShown: { elev: Layer; water: Layer | null } | null = null;
let surfaceShown: Layer | null = null;
let drapeShown: Layer | null | undefined;

const panel = new ConfigPanel($('panel'), spec, {
  onSpecChange(next, final) {
    spec = next;
    syncUrl();
    if (final) regenerate();
  },
});

const atlas = new AtlasPanel(document.body, {
  onSelect(l) {
    const size = world.hf?.size ?? 1024e3;
    // Frame the feature: its extent spans about half the screen height.
    const d = Math.max(9000, (l.extentM * 2) / (2 * Math.tan(world.cam.fovY / 2)));
    world.cam.flyTo(l.x, size - l.y, d);
    world.highlightLandmark(l.id);
  },
  onHover(l) {
    world.highlightLandmark(l ? l.id : null);
  },
});

// Tapping a label selects it and flies there; the hover cursor shows labels are clickable.
orbit.onTap = (sx, sy) => {
  const l = world.labels.hitTest(sx, sy);
  if (l) {
    const size = world.hf?.size ?? 1024e3;
    world.highlightLandmark(l.id);
    world.cam.flyTo(l.x, size - l.y, Math.max(9000, (l.extentM * 2) / (2 * Math.tan(world.cam.fovY / 2))));
  } else {
    world.highlightLandmark(null);
  }
};
canvas.addEventListener('pointermove', (e) => {
  if (mode === '3d') canvas.style.cursor = world.labels.hitTest(e.offsetX, e.offsetY) ? 'pointer' : '';
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
$('mode').addEventListener('click', () => setMode(mode === '3d' ? '2d' : '3d'));
$('atlas-toggle').addEventListener('click', () => atlas.toggle());
const paletteSelect = $<HTMLSelectElement>('palette');
paletteSelect.value = readStored(PALETTE_KEY) ?? 'satellite';
const applyPalette = (): void => {
  const v = paletteSelect.value;
  world.setPalette(v === 'stylised' ? 'stylised' : v === 'hypsometric' ? 'hypsometric' : 'satellite');
  writeStored(PALETTE_KEY, v);
};
paletteSelect.addEventListener('change', applyPalette);
applyPalette();
const exagInput = $<HTMLInputElement>('exag');
exagInput.addEventListener('input', () => {
  world.setExaggeration(Number(exagInput.value));
  $('exag-value').textContent = exagInput.value;
});
layerSelect.addEventListener('change', () => {
  selected = layerSelect.value;
  writeStored(LAYER_KEY, selected);
  showSelected();
});
window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey) return;
  if (e.code === 'KeyB') startGen('build');
  if (e.code === 'KeyV') setMode(mode === '3d' ? '2d' : '3d');
  if (e.code === 'KeyA') atlas.toggle();
  if (e.code === 'Home' && mode === '2d') fitView();
});
canvas.addEventListener('pointermove', (e) => inspect(e.offsetX, e.offsetY));
canvas.addEventListener('pointerleave', () => (inspectEl.textContent = ''));
canvas.addEventListener('dblclick', () => (mode === '2d' ? fitView() : undefined));

setMode(mode);
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
      if (msg.vectors?.rivers) {
        rivers = msg.vectors.rivers;
        world.setRivers(rivers);
      }
      if (msg.vectors?.landmarks) {
        landmarks = msg.vectors.landmarks;
        world.setLandmarks(landmarks);
        atlas.set(landmarks, msg.vectors.traits ?? null);
      }
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
  const elev = layers.get('elevation');
  // Water rasters only match the elevation produced by the same stage.
  const water = layers.get('waterLevel');
  const wl = water && water.stage === elev?.stage ? water : null;
  if (elev && (elev !== terrainShown?.elev || wl !== terrainShown.water)) {
    terrainShown = { elev, water: wl };
    const cls = layers.get('waterClass');
    world.setTerrain(elev, wl, cls && cls.stage === elev.stage ? cls : null);
    world.setRivers(rivers);
    minimap.setTerrain(elev, wl);
    const mask = (id: string): Layer | null => {
      const l = layers.get(id);
      return l && l.w === elev.w ? l : null;
    };
    world.setLandformMasks({ reef: mask('reef'), erg: mask('erg'), crater: mask('crater'), cliff: mask('cliff'), n: elev.w });
    const wc = layers.get('waterClass');
    const dis = layers.get('discharge');
    world.setCreekWorld(
      rivers && wc && dis && wc.stage === elev.stage && dis.stage === elev.stage
        ? { elevation: elev, waterClass: wc, discharge: dis, rivers, seed: spec.seed }
        : null,
    );
  }
  // Realistic colouring needs the biome stage's rasters, which match the hydro-stage terrain grid.
  const biome = layers.get('biome');
  if (biome && biome !== surfaceShown && elev && biome.w === elev.w) {
    const temperature = layers.get('temperature');
    const aridity = layers.get('aridity');
    const canopy = layers.get('canopy');
    const snow = layers.get('snow');
    if (temperature && aridity && canopy && snow) {
      surfaceShown = biome;
      world.setSurface({ temperature, aridity, summerRain: layers.get('summerRain') ?? null, canopy, snow, biome });
      const wl2 = layers.get('waterLevel');
      const wc = layers.get('waterClass');
      const dis = layers.get('discharge');
      if (wl2 && wc && dis && elev.stage === 'hydro') {
        world.buildDetail({
          elevation: elev, waterLevel: wl2, waterClass: wc, discharge: dis, biome, rivers, seed: spec.seed,
          size: resolve(spec).values.detailGrid === '2048' ? 2048 : 4096,
        });
      }
    }
  }
  const drape = l.id === 'elevation' ? null : l;
  if (drape !== drapeShown) {
    drapeShown = drape;
    world.setDrape(drape);
  }
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
  let x = cam.screenToWorldX(sx);
  let y = cam.screenToWorldY(sy);
  if (mode === '3d') {
    const p = world.cam.pick(sx, sy);
    if (!p || !world.hf) {
      inspectEl.textContent = '';
      return;
    }
    ({ xKm: x, yKm: y } = worldToMapKm(p.x, p.y, world.hf.size));
  }
  const l = layers.get(shownLayerId());
  const elev = layers.get('elevation');
  if (!l) return;
  const v = sampleLayer(l, x, y);
  if (v === null) {
    inspectEl.textContent = '';
    return;
  }
  const lines = [`${x.toFixed(1)} km, ${y.toFixed(1)} km`, `${l.label}: ${fmtNum(v)} ${l.unit}`];
  const near = nearestLandmark(x * 1000, y * 1000);
  if (near) lines.unshift(`${near.name} (${KIND_LABEL[near.kind].toLowerCase()})`);
  if (elev && elev !== l) lines.push(`Elevation: ${fmtNum(sampleLayer(elev, x, y) ?? 0)} m`);
  inspectEl.textContent = lines.join('\n');
}

/** The most important landmark whose extent covers a map point (metres), for the inspector. */
function nearestLandmark(xm: number, ym: number): Landmark | null {
  let best: Landmark | null = null;
  let bestScore = 0;
  for (const l of landmarks) {
    const d = Math.hypot(l.x - xm, l.y - ym);
    const r = Math.max(2000, l.extentM * 0.6);
    if (d > r) continue;
    const score = l.importance * (1 - d / r) + 0.001;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return best;
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
  if (mode === '3d') {
    world.resize();
    orbit.update(dt);
    world.cam.update(dt);
    world.draw(now / 1000);
    minimap.draw();
    compass.update();
  } else {
    view.resize(cam);
    camCtl.update(dt);
    view.draw(cam);
  }
  requestAnimationFrame(frame);
}

function setMode(m: '3d' | '2d'): void {
  mode = m;
  writeStored(MODE_KEY, m);
  orbit.enabled = m === '3d';
  camCtl.enabled = m === '2d';
  document.body.classList.toggle('mode-2d', m === '2d');
  $('mode').textContent = m === '3d' ? '2D' : '3D';
  if (m === '2d') fitView();
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
