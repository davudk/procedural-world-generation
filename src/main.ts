import './style.css';
import { exportActions } from './app/export/exportActions';
import { GenHost } from './app/genHost';
import { CameraController, isTypingTarget } from './input/cameraController';
import { OrbitController } from './input/orbitController';
import { worldToMapKm } from './render/camera/ground';
import { Camera } from './render/camera2d';
import { FramePacer } from './render/framePacer';
import { GlobeMinimap } from './render/globeMinimap';
import { Minimap } from './render/minimap';
import { RasterView, sampleLayer } from './render/rasterView';
import { equirectLatLon, projectSphereLayer, type ProjectedLayer, type SphereProjection } from './render/sphereProjection';
import { parseQualityChoice, pickQuality, probeDevice, type QualityChoice } from './render/quality';
import { WorldView } from './render/worldView';
import { fmtNum, resolve } from './shared/config/resolve';
import { dirToCell } from './shared/cube';
import type { WorldShape, WorldSpec } from './shared/config/types';
import { queryToSpec, specToQuery } from './shared/config/url';
import type { Landmark, WorldTraits } from './shared/landmarks';
import type { FromWorker, GenMode, Layer, RiverGraph } from './shared/protocol';
import { AtlasPanel, KIND_LABEL } from './ui/atlas';
import { Compass } from './ui/compass';
import { ConfigPanel } from './ui/configPanel';
import { ExportMenu } from './ui/exportMenu';
import { ViewControls } from './ui/viewControls';
import { GenProgress } from './ui/genProgress';

/** Delay after the last settings change before a full-quality build starts. */
const BUILD_IDLE_MS = 900;
const LAYER_KEY = 'pwg.layer';
const MODE_KEY = 'pwg.mode';
const PALETTE_KEY = 'pwg.palette';
const QUALITY_KEY = 'pwg.quality';
const PROJECTION_KEY = 'pwg.sphereProjection';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const seedInput = $<HTMLInputElement>('seed');
const progress = new GenProgress($('progress'), $('topbar'));
const layerSelect = $<HTMLSelectElement>('layer-select');
const legendEl = $('legend');
const inspectEl = $('inspect');

let spec: WorldSpec = queryToSpec(location.search, randomSeed());
const layers = new Map<string, Layer>();
let selected = readStored(LAYER_KEY) ?? 'elevation';
let fittedFor: number | string = -1;
let buildTimer = 0;
let rivers: RiverGraph | null = null;
let landmarks: Landmark[] = [];
let traits: WorldTraits | null = null;
/** Realised 🎯 targets of the current run; later stages refine earlier values. */
let outcomes: Record<string, number> = {};

// The 3D world creates the WebGL2 context; the 2D raster view shares it.
const world = new WorldView(canvas);
const orbit = new OrbitController(canvas, world.cam);
const minimap = new Minimap($('layers'), world.cam);
const globeMinimap = new GlobeMinimap($('layers'), world.globeCam);
const compass = new Compass($('compass-host'), world.cam);
// Time of day, season and clouds (M9 view settings, stored locally; T animates the time).
$('legend').before(new ViewControls($('layers'), (s) => Object.assign(world.view, s)).el);
const cam = new Camera();
let view = new RasterView(canvas);
const camCtl = new CameraController(canvas, cam, () => ({ w: currentWorldKm(), h: currentWorldHeightKm() }));
/** Debug handle for the console / browser automation. */
Object.assign(window, { __pwg: { world, orbit, layers: () => layers } });
let mode: '3d' | '2d' = readStored(MODE_KEY) === '2d' ? '2d' : '3d';
let terrainShown: { elev: Layer; water: Layer | null } | null = null;
let surfaceShown: Layer | null = null;
let drapeShown: Layer | null | undefined;
/** Shape of the world being generated; layers from a world of the other shape are dropped. */
let genShape: WorldShape | null = null;
/** Spheres show in the 2D view as an equirectangular map or a cube net (research 10 §6.8). */
let sphereProjection: SphereProjection = readStored(PROJECTION_KEY) === 'net' ? 'net' : 'equirect';
/** The projected sphere layer on screen (null for flat maps). */
let sphereShown: ProjectedLayer | null = null;
/** Sphere layers last handed to the globe (elevation, climate, drape). */
let globeShown: { elev: Layer | null; water: Layer | null; temp: Layer | null; biome: Layer | null; drape: Layer | null | undefined } = {
  elev: null, water: null, temp: null, biome: null, drape: undefined,
};

// ── Mobile pass: quality tier, idle frame cap, context loss, export (M9) ──────────────────

const device = probeDevice(world.gl);
// `?quality=low|medium|high` overrides for this page load; the Export menu's choice is remembered.
let qualityChoice: QualityChoice = parseQualityChoice(new URLSearchParams(location.search).get('quality')) ?? parseQualityChoice(readStored(QUALITY_KEY)) ?? 'auto';
const applyQuality = (): void => {
  world.setQuality(pickQuality(qualityChoice, device));
  document.body.dataset.quality = world.quality.tier;
  pacer.wake();
};
const pacer = new FramePacer(world.quality.idleFps);
applyQuality();

// Short notices, faded out after a few seconds.
const noticeEl = document.createElement('div');
noticeEl.className = 'view-notice hidden';
noticeEl.setAttribute('role', 'status');
document.body.append(noticeEl);
let noticeTimer = 0;
function notice(text: string): void {
  noticeEl.textContent = text;
  noticeEl.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => noticeEl.classList.add('hidden'), 4500);
}

// Spheres: switch the 2D map between the equirectangular projection and the cube net.
const projectionEl = document.createElement('button');
projectionEl.type = 'button';
projectionEl.className = 'projection-toggle';
projectionEl.hidden = true;
projectionEl.title = 'Show the planet as an equirectangular map or as the six cube faces (P)';
projectionEl.addEventListener('click', () => toggleProjection());
legendEl.after(projectionEl);
function toggleProjection(): void {
  sphereProjection = sphereProjection === 'net' ? 'equirect' : 'net';
  writeStored(PROJECTION_KEY, sphereProjection);
  showSelected();
}

const glLostEl = document.createElement('div');
glLostEl.className = 'gl-lost hidden';
glLostEl.setAttribute('role', 'status');
document.body.append(glLostEl);
let glLostTimer = 0;
world.onContextChange = (lost) => {
  glLostEl.classList.toggle('hidden', !lost);
  clearTimeout(glLostTimer);
  if (lost) {
    glLostEl.textContent = 'Graphics context lost — restoring…';
    // Some browsers never restore (e.g. after repeated GPU resets): offer a reload.
    glLostTimer = window.setTimeout(() => {
      glLostEl.innerHTML = 'Graphics context lost. <button type="button">Reload</button>';
      glLostEl.querySelector('button')!.addEventListener('click', () => location.reload());
    }, 6000);
    return;
  }
  // WorldView rebuilt its passes; the 2D raster view shares the context and is rebuilt here.
  view = new RasterView(canvas);
  const l = layers.get(shownLayerId());
  if (l) view.setLayer(l);
  pacer.wake();
};

new ExportMenu(document.body, $('export-toggle'), {
  actions: exportActions({
    world,
    spec: () => spec,
    mode: () => mode,
    // Spheres export their equirectangular projection (the six raw faces are not an image).
    layer: (id) => {
      const l = layers.get(id);
      return l?.faces === 6 ? projectSphereLayer(l, 'equirect') : l;
    },
    shownLayer: () => sphereShown ?? layers.get(shownLayerId()),
    landmarks: () => landmarks,
    traits: () => traits,
  }),
  quality: {
    value: qualityChoice,
    options: [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low (mobile)']],
    onChange(v) {
      qualityChoice = parseQualityChoice(v) ?? 'auto';
      writeStored(QUALITY_KEY, qualityChoice);
      applyQuality();
    },
    note: () => {
      const q = world.quality;
      return `${q.tier}: ${q.msaa ? `${q.msaa}× MSAA` : 'no MSAA'}, ≤ ${q.maxPixelRatio}× pixels, ${q.maxDetail}² detail (next build)`;
    },
  },
});

// Panels below the top bar follow its height (it wraps to two or three rows on phones).
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--topbar-h', `${Math.ceil($('topbar').getBoundingClientRect().bottom) + 8}px`);
}).observe($('topbar'));
const layersEl = $('layers');
const setLayersCollapsed = (c: boolean): void => {
  layersEl.classList.toggle('collapsed', c);
  $('layers-toggle').setAttribute('aria-expanded', String(!c));
};
// Phones start with the layer box folded to the minimap and inspector.
setLayersCollapsed(window.matchMedia('(max-width: 760px)').matches);
$('layers-toggle').addEventListener('click', () => setLayersCollapsed(!layersEl.classList.contains('collapsed')));

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
// A tap also fills the inspector (touch screens have no hover).
orbit.onTap = (sx, sy) => {
  inspect(sx, sy);
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
  if (e.code === 'KeyP' && sphereShown) toggleProjection();
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
  const resolved = resolve(spec);
  const shape = resolved.values.worldShape as WorldShape;
  if (shape !== genShape) {
    // The other shape's layers (and rivers, landmarks) no longer describe this world.
    if (genShape !== null) clearWorld();
    genShape = shape;
  }
  progress.start(mode, shape);
  outcomes = {};
  gen.generate(resolved, mode);
}

function clearWorld(): void {
  layers.clear();
  layerSelect.replaceChildren();
  rivers = null;
  landmarks = [];
  traits = null;
  world.setRivers(null);
  world.setLandmarks([]);
  atlas.set([], null);
  sphereShown = null;
  world.clearGlobe();
  globeShown = { elev: null, water: null, temp: null, biome: null, drape: undefined };
  terrainShown = null;
  surfaceShown = null;
  drapeShown = undefined;
  syncCamera();
}

/** Input, compass and minimap follow the camera of the world shape on show. */
function syncCamera(): void {
  orbit.cam = world.activeCam;
  compass.cam = world.activeCam;
  minimap.el.hidden = world.sphere;
  globeMinimap.el.hidden = !world.sphere;
}

function onGenEvent(msg: FromWorker): void {
  switch (msg.type) {
    case 'stage-start':
      progress.stageStart(msg.stage, msg.label);
      break;
    case 'stage-done': {
      const stats = Object.entries(msg.stats)
        .map(([k, v]) => `${k}: ${fmtNum(v)}`)
        .join('\n');
      progress.stageDone(msg.stage, msg.label, msg.ms, msg.cached, `${msg.cached ? 'cached' : `${Math.round(msg.ms)} ms`}\n${stats}`);
      for (const l of msg.layers) layers.set(l.id, l);
      if (msg.vectors?.rivers) {
        rivers = msg.vectors.rivers;
        world.setRivers(rivers);
      }
      if (msg.vectors?.landmarks) {
        landmarks = msg.vectors.landmarks;
        traits = msg.vectors.traits ?? null;
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
      progress.fail();
      break;
    case 'done':
      progress.finish();
      break;
    case 'cancelled':
      break;
  }
}

// ── Layers, legend, inspector ─────────────────────────────────────────────────────────────

function refreshLayerList(): void {
  const ids = [...layers.keys()];
  if (layerSelect.options.length === ids.length) return;
  const option = (id: string, text: string): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = text;
    return o;
  };
  // The elevation layer is the finished world (realistic colouring, water, rivers, labels); every
  // other layer drapes one generation raster over the terrain for inspection.
  const data = document.createElement('optgroup');
  data.label = 'Data layers';
  data.append(...ids.filter((id) => id !== 'elevation').map((id) => option(id, `${layers.get(id)!.label}  (${layers.get(id)!.stage})`)));
  layerSelect.replaceChildren(...(layers.has('elevation') ? [option('elevation', 'World (final, realistic)')] : []), data);
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
  if (l.faces === 6) {
    showSphere(l);
    return;
  }
  sphereShown = null;
  projectionEl.hidden = true;
  view.setLayer(l);
  pacer.wake();
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
      world.setSurface({
        temperature, aridity, summerRain: layers.get('summerRain') ?? null, canopy, snow, biome,
        tempRange: layers.get('tempRange') ?? null, precip: layers.get('precip') ?? null,
      });
      const wl2 = layers.get('waterLevel');
      const wc = layers.get('waterClass');
      const dis = layers.get('discharge');
      if (wl2 && wc && dis && elev.stage === 'hydro') {
        world.buildDetail({
          elevation: elev, waterLevel: wl2, waterClass: wc, discharge: dis, biome, rivers, seed: spec.seed,
          size: resolve(spec).values.detailGrid === '2048' || world.quality.maxDetail === 2048 ? 2048 : 4096,
        });
      }
    }
  }
  const drape = l.id === 'elevation' ? null : l;
  if (drape !== drapeShown) {
    drapeShown = drape;
    world.setDrape(drape);
  }
  syncCamera();
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

/**
 * A cube-sphere layer: projected on the main thread for the 2D view (cached per layer), and handed
 * to the globe in 3D (research 10 §6). The globe shows the latest elevation with the hydrology
 * stage's lakes, coloured by the biome stage (or by climate before it exists); any other layer drapes
 * over it.
 */
function showSphere(l: Layer): void {
  const shown = projectSphereLayer(l, sphereProjection);
  sphereShown = shown;
  view.setLayer(shown);
  pacer.wake();
  const elev = layers.get('elevation') ?? layers.get('lemElevation') ?? layers.get('h0');
  // Water rasters only match the elevation produced by the same stage.
  const wl = layers.get('waterLevel');
  const water = wl && wl.faces === 6 && wl.stage === elev?.stage ? wl : null;
  if (elev && elev.faces === 6 && (elev !== globeShown.elev || water !== globeShown.water)) {
    if (!globeShown.elev && mode === '3d') notice('Globe view: no labels or clouds on spheres yet');
    globeShown.elev = elev;
    globeShown.water = water;
    const wc = layers.get('waterClass');
    world.setGlobe(elev, water, wc && wc.stage === elev.stage ? wc : null);
    globeMinimap.setTerrain(elev);
  }
  if (elev && elev.faces === 6) {
    // Close-zoom detail tiles: the hydro stage's discharge and the biome stage's classes refine the
    // amplitude; the view adds its prepared water and the sphere river graph (carved channels). The
    // tiles rebuild when any of these arrive.
    const face6 = (id: string): Layer | null => {
      const x = layers.get(id);
      return x && x.faces === 6 && x.w === elev.w ? x : null;
    };
    const dis = face6('discharge');
    world.setGlobeDetail({ seed: spec.seed, discharge: dis && dis.stage === elev.stage ? dis.data : null, biome: face6('biome')?.data ?? null });
  }
  const temp = layers.get('temperature');
  const sphereLayer = (id: string): Layer | null => {
    const x = layers.get(id);
    return x && x.faces === 6 && temp && x.w === temp.w ? x : null;
  };
  const biome = sphereLayer('biome');
  if (temp && temp.faces === 6 && (temp !== globeShown.temp || biome !== globeShown.biome)) {
    globeShown.temp = temp;
    globeShown.biome = biome;
    world.setGlobeSurface({
      temperature: temp, precip: layers.get('precip') ?? null, summerRain: layers.get('summerRain') ?? null, tempRange: layers.get('tempRange') ?? null,
      aridity: biome ? sphereLayer('aridity') : null, biome, snow: biome ? sphereLayer('snow') : null, erg: biome ? sphereLayer('erg') : null,
    });
  }
  const drape = l.kind === 'elevation' ? null : l;
  if (drape !== globeShown.drape) {
    globeShown.drape = drape;
    world.setGlobeDrape(drape);
  }
  syncCamera();
  projectionEl.hidden = false;
  projectionEl.textContent = sphereProjection === 'net' ? 'Show map' : 'Show cube net';
  const key = `${shown.projection}:${shown.worldKm}`;
  if (fittedFor !== key) {
    fittedFor = key;
    fitView();
  }
  const cell = (l.worldKm / l.w).toFixed(2);
  legendEl.textContent =
    l.kind === 'categorical'
      ? `6 × ${l.w}² cells · ${cell} km/cell · ${l.max + 1} classes`
      : `6 × ${l.w}² cells · ${cell} km/cell · ${fmtNum(l.min)} … ${fmtNum(l.max)} ${l.unit}`;
}

function inspect(sx: number, sy: number): void {
  let x = cam.screenToWorldX(sx);
  let y = cam.screenToWorldY(sy);
  if (mode === '3d' && world.sphere) {
    inspectGlobe(sx, sy);
    return;
  }
  if (sphereShown) {
    inspectSphere(sphereShown, x, y);
    return;
  }
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

function inspectSphere(shown: ProjectedLayer, x: number, y: number): void {
  const v = sampleLayer(shown, x, y);
  if (v === null) {
    inspectEl.textContent = '';
    return;
  }
  const lines = [`${shown.label}: ${fmtNum(v)} ${shown.unit}`];
  if (shown.projection === 'equirect') {
    const [lat, lon] = equirectLatLon(shown, x, y);
    lines.unshift(`${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}`);
  }
  const elev = layers.get('elevation');
  if (elev && elev.label !== shown.label && elev.faces === 6) {
    const e = sampleLayer(projectSphereLayer(elev, shown.projection), x, y);
    if (e !== null) lines.push(`Elevation: ${fmtNum(e)} m`);
  }
  inspectEl.textContent = lines.join('\n');
}

/** Inspector on the globe: latitude / longitude of the picked point and the raw face values there. */
function inspectGlobe(sx: number, sy: number): void {
  const p = world.globeCam.pick(sx, sy);
  const l = layers.get(shownLayerId());
  if (!p || !l || l.faces !== 6) {
    inspectEl.textContent = '';
    return;
  }
  const r = Math.hypot(p.x, p.y, p.z);
  const lat = (Math.asin(p.z / r) * 180) / Math.PI;
  const lon = (Math.atan2(p.y, p.x) * 180) / Math.PI;
  const at = (layer: Layer): number => layer.data[dirToCell(p.x, p.y, p.z, layer.w)];
  const lines = [
    `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`,
    `${l.label}: ${fmtNum(at(l))} ${l.unit}`,
  ];
  const elev = layers.get('elevation');
  if (elev && elev !== l && elev.faces === 6) lines.push(`Elevation: ${fmtNum(at(elev))} m`);
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
  cam.fit(currentWorldKm(), currentWorldHeightKm(), { top, right: docked ? window.innerWidth - panelEl.getBoundingClientRect().left : 0, bottom: 0, left: 0 });
  camCtl.setZoom(cam.zoom);
}

function currentWorldKm(): number {
  return sphereShown?.worldKm ?? layers.get(shownLayerId())?.worldKm ?? 1024;
}

function currentWorldHeightKm(): number {
  return sphereShown ? (sphereShown.worldKm * sphereShown.h) / sphereShown.w : currentWorldKm();
}

// ── Frame loop ────────────────────────────────────────────────────────────────────────────

let last = performance.now();
const view2dMatrix = new Float32Array(9);
let view2dKey = '';
/**
 * Input and camera easing run every animation frame; drawing is paced (M9): full rate while anything
 * moves, `idleFps` when only animated water changes, nothing in the static 2D view.
 */
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === '3d') {
    world.resize();
    orbit.update(dt);
    if (world.sphere) world.globeCam.update(dt);
    else world.cam.update(dt);
    if (pacer.shouldDraw(now, world.needsFrame, true)) {
      world.draw(now / 1000);
      if (world.sphere) globeMinimap.draw();
      else minimap.draw();
      compass.update();
    }
  } else {
    view.resize(cam);
    camCtl.update(dt);
    const key = `${cam.viewMatrix(view2dMatrix).join(',')}|${canvas.width}x${canvas.height}`;
    if (pacer.shouldDraw(now, key !== view2dKey, false)) {
      view2dKey = key;
      view.draw(cam);
    }
  }
  requestAnimationFrame(frame);
}

function setMode(m: '3d' | '2d'): void {
  mode = m;
  pacer.wake();
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
