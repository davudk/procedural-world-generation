import type { Landmark } from '../shared/landmarks';
import type { Layer, RiverGraph } from '../shared/protocol';
import type { GroundQuery, Vec3 } from './camera/ground';
import { OrbitCamera } from './camera/orbitCamera';
import { GlobeCamera } from './camera/globeCamera';
import { applyViewSize, type ViewCamera } from './camera/viewCamera';
import { GlobeSkyPass, type GlobeAtmosFrame } from './globe/atmosphere';
import { GlobeHeightField, SphereGround } from './globe/globeGround';
import { GlobePass, type GlobeSurface } from './globe/globePass';
import { GlobeDetail, globeDetailOptions } from './globe/globeDetail';
import type { GlobeDetailWorld } from './globe/detailTiles';
import { GlobeDetailUniforms } from './glsl/globeDetail';
import { GlobeDetailGround } from './height/globeHeightFn';
import { SphereCdlodSelector } from './terrain/cdlodSphere';
import { HeightField, prepareWater } from './heightField';
import { CdlodSelector, GRID } from './terrain/cdlod';
import type { Palette } from './terrain/biomeLut';
import { DetailUniforms } from './glsl/detail';
import { DetailGround, HeightFn } from './height/heightFn';
import { HorizonPass } from './lighting/horizon';
import { qualitySettings, pixelRatio, type QualitySettings } from './quality';
import { LabelLayer } from './labels/labelLayer';
import { DetailMap, type DetailInput } from './terrain/detail/detailMap';
import { SkyPass } from './lighting/sky';
import { CloudPass } from './lighting/clouds';
import { declination, DEFAULT_SEASON, DEFAULT_TIME, DEFAULT_VIEW, seasonPhase, sunLight, type ViewSettings } from './lighting/sun';
import { TerrainPass, type SurfaceLayers } from './terrain/terrainPass';
import { CreekManager } from './water/creeks/creekManager';
import { RiverPass } from './water/rivers';

/** Cloud base above sea level (m, before exaggeration). */
const CLOUD_BASE = 3200;
/** Cloud drift (m/s); time-of-day animation runs the clouds faster too. */
const CLOUD_WIND = [9, 4] as const;

/** Flat placeholder ground until the first elevation arrives. */
class FlatGround implements GroundQuery {
  constructor(readonly size: number) {}
  heightAt(): number {
    return 0;
  }
  raycast(o: Vec3, d: Vec3): Vec3 | null {
    if (Math.abs(d.z) < 1e-12) return null;
    const t = -o.z / d.z;
    return t < 0 ? null : { x: o.x + d.x * t, y: o.y + d.y * t, z: 0 };
  }
}

type CreekWorld = { elevation: Layer; waterClass: Layer; discharge: Layer; rivers: RiverGraph; seed: number };
type LandformMasks = { reef: Layer | null; erg: Layer | null; crater: Layer | null; cliff: Layer | null; n: number };

/**
 * The 3D world view (M2): CDLOD terrain with a water lid, orbit camera, reversed-Z where
 * EXT_clip_control exists, and MSAA (per quality tier) into a float-depth framebuffer blitted to the canvas.
 * Sphere worlds (Sphere phase 3) draw the globe instead: six-root CDLOD, the globe camera and an
 * atmosphere; `sphere` says which of the two the view shows.
 *
 * Every GPU object lives in the passes created by `initGpu()`; the inputs they were fed are kept here
 * as CPU copies, so a lost WebGL context is rebuilt on `webglcontextrestored` without a reload (M9).
 */
export class WorldView {
  readonly gl: WebGL2RenderingContext;
  readonly cam: OrbitCamera;
  /** Camera for sphere worlds (research 10 §6.4). */
  readonly globeCam: GlobeCamera;
  hf: HeightField | null = null;
  /** CPU elevation of the sphere world, when one is shown. */
  globeHf: GlobeHeightField | null = null;
  /** True while a sphere world is shown (the globe is drawn instead of the flat terrain). */
  sphere = false;
  readonly reversedZ: boolean;
  /** Geometric vertical exaggeration (user setting). */
  exaggeration = 1.5;
  nodes = 0;
  /** Render quality (DPR cap, MSAA, CDLOD density); set with `setQuality`. */
  quality: QualitySettings = qualitySettings('high');
  /** True between `webglcontextlost` and the rebuild on `webglcontextrestored`. */
  contextLost = false;
  /** Called after a context loss (true) and after the rebuild (false). */
  onContextChange?: ((lost: boolean) => void) | undefined;
  private readonly selector = new CdlodSelector();
  private readonly sphereSelector = new SphereCdlodSelector();
  // GPU passes: re-created by initGpu() after a context loss.
  private terrain!: TerrainPass;
  rivers!: RiverPass;
  creekPass!: RiverPass;
  readonly creeks = new CreekManager();
  private horizon!: HorizonPass;
  private sky!: SkyPass;
  private clouds!: CloudPass;
  private globe!: GlobePass;
  private globeSky!: GlobeSkyPass;
  /** Time of day, season and clouds (M9 view settings; the defaults keep the pre-M9 look). */
  view: ViewSettings = { ...DEFAULT_VIEW };
  private cloudDrift: [number, number] = [0, 0];
  private lastTime = -1;
  private detail!: DetailMap;
  private detailU!: DetailUniforms;
  private detailSeen = -1;
  private ground: DetailGround | null = null;
  /** Streamed close-zoom detail tiles of the sphere world (Sphere phase 4b). */
  globeDetail!: GlobeDetail;
  private globeDetailU!: GlobeDetailUniforms;
  private globeDetailSeen = -1;
  private globeGround: GlobeDetailGround | null = null;
  private globeDetailTier = '';
  private lastGlobeTime = -1;
  labels!: LabelLayer;
  private creekWorld: CreekWorld | null = null;
  // CPU copies of everything uploaded, replayed after a context loss.
  private readonly src: {
    terrain: [Layer, Layer | null, Layer | null] | null;
    surface: SurfaceLayers | null;
    masks: LandformMasks | null;
    rivers: RiverGraph | null;
    landmarks: readonly Landmark[];
    highlight: number | null;
    drape: Layer | null;
    detail: DetailInput | null;
    globe: Layer | null;
    globeSurface: GlobeSurface | null;
    globeDrape: Layer | null;
    globeDetail: GlobeDetailWorld | null;
  } = {
    terrain: null, surface: null, masks: null, rivers: null, landmarks: [], highlight: null, drape: null, detail: null,
    globe: null, globeSurface: null, globeDrape: null, globeDetail: null,
  };
  /** Camera and viewport state of the last drawn frame (to skip redraws when nothing changed). */
  private drawnKey = '';
  /** Set by uploads; cleared by draw(). */
  private dirty = true;
  private fbSamples = -1;
  private readonly viewProj = new Float32Array(16);
  private readonly planes = new Float64Array(24);
  private fbo: WebGLFramebuffer | null = null;
  private colorRb: WebGLRenderbuffer | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
  private fbW = 0;
  private fbH = 0;
  private dpr = 1;
  private fittedSize = -1;
  private fittedRadius = -1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // alpha: true makes the default framebuffer RGBA8, matching the MSAA colour buffer: a multisample
    // resolve blit requires identical formats. Everything is drawn opaque.
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, depth: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.reversedZ = this.enableClipControl();
    this.cam = new OrbitCamera(new FlatGround(1024e3));
    this.cam.reversedZ = this.reversedZ;
    this.globeCam = new GlobeCamera(new SphereGround(652e3));
    this.globeCam.reversedZ = this.reversedZ;
    this.initGpu();
    // Without preventDefault() on the loss the browser never restores the context.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextChange?.(true);
    });
    canvas.addEventListener('webglcontextrestored', () => this.restore());
  }

  /** Reversed-Z through EXT_clip_control (extension state is per context, so this re-runs on restore). */
  private enableClipControl(): boolean {
    const clip = this.gl.getExtension('EXT_clip_control') as { clipControlEXT(o: number, d: number): void; LOWER_LEFT_EXT: number; ZERO_TO_ONE_EXT: number } | null;
    if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.ZERO_TO_ONE_EXT);
    return clip !== null;
  }

  /** Creates every pass, and so every GPU object, for the current context (again after a restore). */
  private initGpu(): void {
    const gl = this.gl;
    const palette = this.terrain?.palette;
    const labelsOn = this.labels?.enabled ?? true;
    this.terrain = new TerrainPass(gl);
    this.globe = new GlobePass(gl);
    if (palette) this.terrain.palette = this.globe.palette = palette;
    this.globeSky = new GlobeSkyPass(gl);
    this.rivers = new RiverPass(gl);
    this.creekPass = new RiverPass(gl);
    // Creeks fade in at the zooms the camera can reach (the manager must use the same constant).
    this.creekPass.lodC = 35;
    this.creeks.lodC = 35;
    this.horizon = new HorizonPass(gl);
    this.sky = new SkyPass(gl);
    this.detail = new DetailMap(gl);
    this.detailU = new DetailUniforms(this.detail);
    this.detailSeen = -1;
    this.newGlobeDetail();
    this.labels = new LabelLayer(gl);
    // The cloud pass holds no data of its own: its climate texture is TerrainPass.climate2 (rebuilt
    // by setSurface, which restore() replays) and everything else is per-frame uniforms.
    this.clouds = new CloudPass(gl);
    this.labels.enabled = labelsOn;
    this.fbo = this.colorRb = this.depthRb = null;
    this.fbW = this.fbH = 0;
    this.fbSamples = -1;
  }

  /** Context restored: new passes, then re-upload the last world from the CPU copies. */
  private restore(): void {
    if (this.gl.isContextLost()) return; // lost again: wait for the next restore event
    // A restored context normally keeps its extensions; if not, depth would be inverted, so say so.
    if (this.enableClipControl() !== this.reversedZ) console.warn('EXT_clip_control availability changed after a context restore');
    this.contextLost = false;
    this.initGpu();
    const s = this.src;
    if (s.terrain) this.uploadTerrain(...s.terrain, true);
    this.terrain.setSurface(s.surface);
    this.terrain.setLandformMasks(s.masks);
    this.terrain.setDrape(s.drape);
    this.rivers.setRivers(s.rivers, this.hf?.size ?? 0);
    this.labels.setLandmarks(s.landmarks, this.hf?.size ?? 1024e3);
    this.labels.highlight(s.highlight);
    this.setCreekWorld(this.creekWorld);
    if (s.detail) this.detail.build(s.detail);
    if (s.globe && this.globeHf) this.globe.setTerrain(s.globe, this.globeHf.radius);
    this.globeDetail.setWorld(s.globeDetail);
    this.globe.setSurface(s.globeSurface);
    this.globe.setDrape(s.globeDrape);
    this.dirty = true;
    this.onContextChange?.(false);
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.dirty = true;
    // Tile size and the LRU budget follow the tier: rebuild the tile set when it changes.
    if (this.globeDetail && q.tier !== this.globeDetailTier && !this.contextLost) {
      this.globeDetail.dispose();
      this.newGlobeDetail();
      this.globeDetail.setWorld(this.src.globeDetail);
    }
  }

  /** A fresh tile set for the current quality tier (no world yet). */
  private newGlobeDetail(): void {
    this.globeDetail = new GlobeDetail(this.gl, globeDetailOptions(this.quality.tier));
    this.globeDetailTier = this.quality.tier;
    this.globeDetailU ??= new GlobeDetailUniforms();
    this.globeDetailU.src = this.globeDetail;
    this.globeDetailSeen = -1;
    this.globeGround = null;
  }

  /** Starts building the close-zoom detail map (time-sliced in draw()). */
  buildDetail(input: DetailInput): void {
    this.src.detail = input;
    this.ground = null;
    this.dirty = true;
    if (!this.contextLost) this.detail.build(input);
  }

  /**
   * True when the next frame would differ from the last one drawn: the camera or viewport moved, an
   * eased motion or a label fade runs, the detail map is building, or data was uploaded. Animated
   * water alone does not count (the caller throttles those frames).
   */
  get needsFrame(): boolean {
    if (this.contextLost) return false;
    if (this.sphere) return this.dirty || this.globeCam.moving || this.globeDetail.busy || this.viewKey() !== this.drawnKey;
    return this.dirty || this.cam.moving || this.labels.animating || this.detail.building || this.viewKey() !== this.drawnKey;
  }

  /** The camera the input and the compass drive: the globe camera while a sphere is shown. */
  get activeCam(): ViewCamera {
    return this.sphere ? this.globeCam : this.cam;
  }

  private viewKey(): string {
    if (this.sphere) {
      const g = this.globeCam;
      const d = g.dir;
      return `g|${d.x}|${d.y}|${d.z}|${g.targetH}|${g.distance}|${g.pitch}|${g.bearing}|${this.canvas.width}x${this.canvas.height}|${this.exaggeration}`;
    }
    const c = this.cam;
    const t = c.target;
    return `${t.x}|${t.y}|${t.z}|${c.distance}|${c.pitch}|${c.bearing}|${this.canvas.width}x${this.canvas.height}|${this.exaggeration}`;
  }

  /** Terrain elevation plus optional water level / water class rasters (same grid). */
  setTerrain(layer: Layer, water: Layer | null = null, wclass: Layer | null = null): void {
    this.sphere = false;
    this.src.terrain = [layer, water, wclass];
    const hf = this.uploadTerrain(layer, water, wclass);
    this.cam.setGround(hf);
    if (this.fittedSize !== hf.size) {
      this.fittedSize = hf.size;
      this.cam.fitWorld();
    }
  }

  /**
   * Builds the CPU height field (or keeps the current one after a context restore, since the camera's
   * ground refers to it) and, while the context is alive, uploads the terrain textures.
   */
  private uploadTerrain(layer: Layer, water: Layer | null, wclass: Layer | null, keepHf = false): HeightField {
    const prepared = water !== null && water.w === layer.w ? prepareWater(layer, water, wclass && wclass.w === layer.w ? wclass : null) : null;
    let hf = this.hf;
    if (!hf || !keepHf) {
      hf = new HeightField(layer, prepared?.level ?? null);
      hf.exaggeration = this.exaggeration;
      this.hf = hf;
    }
    this.dirty = true;
    if (!this.contextLost) {
      this.terrain.setTerrain(layer, prepared);
      this.horizon.setSurface(hf.surface, hf.n, hf.size);
    }
    return hf;
  }

  setExaggeration(x: number): void {
    this.exaggeration = x;
    if (this.hf) this.hf.exaggeration = x;
    if (this.globeHf) this.globeHf.exaggeration = x;
  }

  /**
   * Shows a sphere world (six-face elevation): builds the CPU height field and uploads the globe
   * textures. The globe camera fits the planet when its radius changes, otherwise keeps the view.
   */
  setGlobe(layer: Layer, detail: Omit<GlobeDetailWorld, 'n' | 'radius' | 'elevation'> | null = null): void {
    this.sphere = true;
    this.src.globe = layer;
    const hf = new GlobeHeightField(layer);
    hf.exaggeration = this.exaggeration;
    this.globeHf = hf;
    this.globeGround = null;
    this.globeCam.setGround(hf);
    this.globeCam.minMetresPerPixel = 40;
    if (this.fittedRadius !== hf.radius) {
      this.fittedRadius = hf.radius;
      this.globeCam.fitWorld();
    }
    this.dirty = true;
    // Close-zoom detail tiles amplify this elevation (rebuilt from scratch for every new layer).
    this.src.globeDetail = detail ? { ...detail, n: hf.n, radius: hf.radius, elevation: hf.data } : null;
    if (!this.contextLost) {
      this.globe.setTerrain(layer, hf.radius);
      this.globeDetail.setWorld(this.src.globeDetail);
    }
  }

  /** Forgets the sphere world (the next world is flat): the view draws flat terrain again. */
  clearGlobe(): void {
    this.sphere = false;
    this.globeHf = null;
    this.globeGround = null;
    this.src.globe = this.src.globeSurface = this.src.globeDrape = null;
    this.src.globeDetail = null;
    if (!this.contextLost) this.globeDetail.setWorld(null);
    this.dirty = true;
  }

  /** Climate layers for the globe's colours (null: hypsometric tints). */
  setGlobeSurface(s: GlobeSurface | null): void {
    this.src.globeSurface = s;
    this.dirty = true;
    if (!this.contextLost) this.globe.setSurface(s);
  }

  /** Drapes a sphere layer over the globe (null = realistic colouring). */
  setGlobeDrape(layer: Layer | null): void {
    this.src.globeDrape = layer;
    this.dirty = true;
    if (!this.contextLost) this.globe.setDrape(layer);
  }

  setSurface(s: SurfaceLayers | null): void {
    this.src.surface = s;
    this.dirty = true;
    if (!this.contextLost) this.terrain.setSurface(s);
  }

  setLandformMasks(m: LandformMasks | null): void {
    this.src.masks = m;
    this.dirty = true;
    if (!this.contextLost) this.terrain.setLandformMasks(m);
  }

  setPalette(p: Palette | 'hypsometric'): void {
    this.terrain.palette = p;
    this.globe.palette = p;
    this.dirty = true;
  }

  /**
   * Inputs for close-zoom creeks: hydro-stage layers on the terrain grid plus the macro river graph.
   * `heightAt` must not depend on the view (research 07 §2.1).
   */
  setCreekWorld(w: CreekWorld | null): void {
    this.creekWorld = w;
    this.dirty = true;
    const hf = this.hf;
    if (!w || !hf || w.elevation.w !== hf.n) {
      this.creeks.setWorld(null, () => 0);
      if (!this.contextLost) this.creekPass.setRivers(null, 0);
      return;
    }
    const size = hf.size;
    this.creeks.setWorld(
      {
        n: w.elevation.w, cellM: size / w.elevation.w, seed: w.seed,
        elevation: w.elevation.data as Float32Array, waterClass: w.waterClass.data as Float32Array,
        dischargeLog: w.discharge.data as Float32Array, rivers: w.rivers,
      },
      // A fixed footprint keeps creeks independent of the view (research 07 §2.1).
      this.ground ? ((g) => (xm: number, ym: number) => g.detailHeightAt(xm, size - ym, 30))(this.ground) : (xm, ym) => hf.elevationAt(xm, size - ym),
    );
    if (!this.contextLost) this.creekPass.setRivers(null, size);
  }

  /** Feeds the creek manager with the current view (map metres) and uploads new creek ribbons. */
  private updateCreeks(): void {
    const hf = this.hf;
    if (!hf) return;
    const cam = this.cam;
    const size = hf.size;
    let r = 0;
    for (const [sx, sy] of [[0, 0], [cam.viewW, 0], [0, cam.viewH], [cam.viewW, cam.viewH]] as const) {
      const p = cam.planeHit(sx, sy, cam.target.z) ?? cam.pick(sx, sy);
      r = Math.max(r, p ? Math.hypot(p.x - cam.target.x, p.y - cam.target.y) : Infinity);
    }
    const eye = cam.eye();
    const g = this.creeks.update({
      centerX: cam.target.x, centerY: size - cam.target.y,
      radiusM: Math.min(r, 60_000),
      metresPerPixel: cam.metresPerPixel(),
      eye: { x: eye.x, y: size - eye.y, z: eye.z / this.exaggeration },
    });
    if (g) this.creekPass.setRivers(g, size);
  }

  /** Named landmarks for labels (wired to the label layer once it exists). */
  setLandmarks(list: readonly Landmark[]): void {
    this.src.landmarks = list;
    this.dirty = true;
    this.labels.setLandmarks(list, this.hf?.size ?? 1024e3);
  }

  highlightLandmark(id: number | null): void {
    this.src.highlight = id;
    this.dirty = true;
    this.labels.highlight(id);
  }

  setRivers(graph: RiverGraph | null): void {
    this.src.rivers = graph;
    this.dirty = true;
    if (!this.contextLost) this.rivers.setRivers(graph, this.hf?.size ?? 0);
  }

  setDrape(layer: Layer | null): void {
    this.src.drape = layer;
    this.dirty = true;
    if (!this.contextLost) this.terrain.setDrape(layer);
  }

  /** Resizes the drawing buffer to CSS size × pixel ratio (per quality tier) and tells the camera. */
  resize(): void {
    this.dpr = pixelRatio(this.quality, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // A hidden page reports 0 × 0: keep the last real size (a zero side makes the cameras NaN).
    if (!applyViewSize([this.cam, this.globeCam], w, h)) return;
    const bw = Math.max(1, Math.round(w * this.dpr));
    const bh = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  /**
   * Draws one frame and reads it back as RGBA8 (row 0 at the top), labels included. The canvas has no
   * preserved drawing buffer, so the read happens in the same task as the draw, before compositing.
   */
  capture(timeSec: number): { width: number; height: number; pixels: Uint8Array } | null {
    if (this.contextLost) return null;
    this.draw(timeSec);
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const raw = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // GL rows run bottom-up: flip, and force opaque alpha.
    const pixels = new Uint8Array(W * H * 4);
    const row = W * 4;
    for (let y = 0; y < H; y++) pixels.set(raw.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    return { width: W, height: H, pixels };
  }

  draw(timeSec: number): void {
    if (this.contextLost) return;
    const gl = this.gl;
    this.dirty = false;
    this.drawnKey = this.viewKey();
    if (this.sphere) {
      this.drawGlobe(timeSec);
      return;
    }
    this.stepDetail();
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.ensureTargets(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    // Map modes keep the default light; time of day, season, clouds and fog belong to the realistic view.
    const realistic = this.terrain.realistic;
    const sun = realistic ? sunLight(this.view.time, this.view.season, this.cam.bearing) : sunLight(DEFAULT_TIME, DEFAULT_SEASON, this.cam.bearing);
    const haze = sun.skyHorizon;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, timeSec - this.lastTime));
    this.lastTime = timeSec;
    const windK = this.view.animate ? 60 : 1;
    this.cloudDrift = [(this.cloudDrift[0] - CLOUD_WIND[0] * dt * windK) % 2e7, (this.cloudDrift[1] - CLOUD_WIND[1] * dt * windK) % 2e7];
    gl.clearColor(haze[0] * 0.25, haze[1] * 0.27, haze[2] * 0.32, 1);
    gl.clearDepth(this.reversedZ ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const hf = this.hf;
    if (hf) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(this.reversedZ ? gl.GEQUAL : gl.LEQUAL);
      const cam = this.cam;
      const eye = cam.eye();
      cam.viewProjRelative(this.viewProj, eye);
      cam.frustumPlanesRelative(this.planes, eye);
      const pxPerRad = cam.viewH / (2 * Math.tan(cam.fovY / 2));
      const maxDepth = Math.ceil(Math.log2(hf.size / (GRID * 16)));
      const boundsPad = this.detail.ready ? this.detail.boundsPad * this.exaggeration : 50;
      this.nodes = this.selector.select(hf, eye, eye, this.planes, { maxDepth, vertexPx: this.quality.vertexPx, pxPerRad, boundsPad });
      if (this.ground) this.ground.pxFoot = Math.max(cam.metresPerPixel(), hf.size / 2 ** maxDepth / GRID);
      const altitude = Math.max(1, eye.z - hf.heightAt(eye.x, eye.y));
      const tilt = Math.sin(cam.pitch);
      // Light from the top-left of the screen at the default time (lighting/sun.ts).
      const light = sun.dir;
      // Shadows read best with a little more relief than the geometry at far zoom.
      this.horizon.minIntervalMs = this.view.animate ? 120 : 0;
      this.horizon.update(light, this.exaggeration * 1.5);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.DEPTH_TEST);
      this.sky.draw(this.viewProj, { horizon: haze, zenith: sun.skyZenith, glow: sun.glow }, sun.sunDir, this.reversedZ);
      gl.enable(gl.DEPTH_TEST);
      const ph = seasonPhase(this.view.season);
      // Valley fog: low sun, a little more in the cold half of the year.
      const fogK = realistic ? 0.5 * sun.fog * (1 + 0.3 * Math.max(0, -ph.cos)) : 0;
      const atmos = {
        cloudAmount: realistic && this.view.clouds ? 0.7 : 0,
        cloudDrift: this.cloudDrift,
        cloudZ: CLOUD_BASE * this.exaggeration,
        fogK,
        light: sun.light,
        ambient: sun.ambient,
      };
      const hazeK = (tilt * tilt * 1.2) / (altitude * 25) + 1e-9;
      this.terrain.draw({
        lighting: this.horizon.ready ? { sun: this.horizon.texture, ao: this.horizon.aoTexture } : null,
        pxScale: (2 * Math.tan(cam.fovY / 2)) / Math.max(1, cam.viewH),
        detail: this.detailU,
        viewProj: this.viewProj,
        origin: eye,
        instances: this.selector.instances,
        count: this.nodes,
        exaggeration: this.exaggeration,
        normalExaggeration: this.exaggeration * (1.4 + 5.0 * smoothstep(5e3, 6e5, altitude)),
        sun: light,
        // Aerial perspective scales with altitude: low tilted views fade the horizon, high views stay clear.
        haze: hazeK,
        hazeColor: haze,
        time: timeSec,
        season: [ph.cos, ph.sin],
        atmos,
      });
      const atmosFrame = { ...atmos, clim2: this.terrain.climate2 };
      const riverFrame = {
        viewProj: this.viewProj,
        origin: eye,
        exaggeration: this.exaggeration,
        pxScale: (2 * Math.tan(cam.fovY / 2)) / Math.max(1, cam.viewH),
        time: timeSec,
        atmos: realistic && this.horizon.ready
          ? { frame: atmosFrame, fogPot: this.horizon.aoTexture, size: hf.size, sun: light, hazeColor: haze }
          : null,
      };
      this.updateCreeks();
      this.creekPass.draw(riverFrame);
      this.rivers.draw(riverFrame);
      // Visible clouds fade in above ~15 km and stay thin and subtle from far away.
      this.clouds.draw({
        viewProj: this.viewProj, origin: eye, worldSize: hf.size, sun: light, haze: hazeK, hazeColor: haze,
        alpha: 0.6 * smoothstep(15e3, 45e3, altitude) * (1 - 0.45 * smoothstep(2e5, 1.2e6, altitude)),
        atmos: atmosFrame,
      });
      gl.disable(gl.DEPTH_TEST);
      this.labels.draw({ cam, ground: this.ground ?? hf, dpr: this.dpr, timeSec, exaggeration: this.exaggeration });
      gl.disable(gl.DEPTH_TEST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * One globe frame (Sphere phase 3): atmosphere and space, then the sphere CDLOD terrain. Lighting
   * follows research 10 §6.5: the screen-relative cartographic sun near the surface, blending to the
   * real sun (fixed in the planet frame, so the night side shows) as the view rises to globe zoom.
   * The view's time is the solar time at longitude 0; the sun model's colours use the target's own
   * local time and latitude. Detail maps, creeks, rivers, labels and clouds are flat-only for now.
   */
  private drawGlobe(timeSec: number): void {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.ensureTargets(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(this.reversedZ ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const hf = this.globeHf;
    const cam = this.globeCam;
    if (hf) {
      const R = hf.radius;
      const eye = cam.eye();
      cam.viewProjRelative(this.viewProj, eye);
      cam.frustumPlanesRelative(this.planes, eye);
      const pxPerRad = cam.viewH / (2 * Math.tan(cam.fovY / 2));
      const pxScale = (2 * Math.tan(cam.fovY / 2)) / Math.max(1, cam.viewH);
      const gd = this.globeDetail;
      const dt = this.lastGlobeTime < 0 ? 0 : Math.min(0.1, Math.max(0, timeSec - this.lastGlobeTime));
      this.lastGlobeTime = timeSec;
      const detailOn = gd.params !== null && gd.fn !== null;
      const pad = detailOn ? gd.boundsPad * this.exaggeration : 0;
      // Stream tiles around the camera, time-sliced: ~2-3 ms of CPU + estimated GPU work per frame.
      gd.update({ eye, pxScale, planes: this.planes, maxHeight: hf.maxHeight + pad }, dt, cam.moving ? 2 : 3);
      this.syncGlobeGround(hf);
      // With detail, leaves every ~16 m as on flat maps; without, every 1/8 cell.
      const faceM = (Math.PI / 2) * R;
      const maxDepth = detailOn ? Math.max(SphereCdlodSelector.depthFor(hf.n), Math.ceil(Math.log2(faceM / (GRID * 16)))) : SphereCdlodSelector.depthFor(hf.n);
      this.nodes = this.sphereSelector.select(hf, eye, this.planes, {
        maxDepth, vertexPx: this.quality.vertexPx, pxPerRad, boundsPad: pad,
      });
      if (this.globeGround) {
        const mpp = cam.metresPerPixel();
        this.globeGround.pxFoot = Math.max(Number.isFinite(mpp) ? mpp : 1e6, faceM / 2 ** maxDepth / GRID);
      }
      const realistic = this.globe.realistic;
      const time = realistic ? this.view.time : DEFAULT_TIME;
      const season = realistic ? this.view.season : DEFAULT_SEASON;
      const [lat, lon] = cam.latLon();
      const local = sunLight(realistic ? (((time + lon / 15) % 24) + 24) % 24 : time, season, cam.bearing, (lat * Math.PI) / 180);
      // Cartographic sun in screen coordinates (right, up, local up).
      const b = cam.bearing;
      const sd = local.dir;
      const sunCarto = [sd[0] * Math.cos(b) - sd[1] * Math.sin(b), sd[0] * Math.sin(b) + sd[1] * Math.cos(b), sd[2]] as const;
      const ax = cam.axes();
      const up = cam.dir;
      const cartoWorld: [number, number, number] = [
        sunCarto[0] * ax.r.x + sunCarto[1] * ax.fh.x + sunCarto[2] * up.x,
        sunCarto[0] * ax.r.y + sunCarto[1] * ax.fh.y + sunCarto[2] * up.y,
        sunCarto[0] * ax.r.z + sunCarto[1] * ax.fh.z + sunCarto[2] * up.z,
      ];
      // Real sun: declination from the season, sub-solar longitude from the time at longitude 0.
      const dec = declination(season);
      const lonS = (-(time - 12) / 24) * 2 * Math.PI;
      const sunReal = [Math.cos(dec) * Math.cos(lonS), Math.cos(dec) * Math.sin(lonS), Math.sin(dec)] as const;
      const altitude = cam.clearance();
      const realK = realistic ? smoothstep(0.03 * R, 0.4 * R, cam.altitude()) : 0;
      const atmos: GlobeAtmosFrame = { eye, radius: R, sun: realistic ? sunReal : cartoWorld, sunI: 1.0 };
      gl.disable(gl.DEPTH_TEST);
      this.globeSky.draw(this.viewProj, this.reversedZ, atmos, atmos.sun);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(this.reversedZ ? gl.GEQUAL : gl.LEQUAL);
      const ph = seasonPhase(season);
      this.globe.draw({
        viewProj: this.viewProj,
        instances: this.sphereSelector.instances,
        count: this.nodes,
        exaggeration: this.exaggeration,
        normalExaggeration: this.exaggeration * (1.4 + 5.0 * smoothstep(5e3, 6e5, altitude)),
        sunCarto,
        camRight: ax.r,
        camUp: ax.u,
        sunReal,
        realK,
        light: local.light,
        ambient: local.ambient,
        realistic,
        season: realistic ? [ph.cos, ph.sin] : [1, 0],
        time: timeSec,
        atmos,
        detail: this.globeDetailU,
        eye,
        pxScale,
      });
      gl.disable(gl.DEPTH_TEST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Swaps the globe camera onto the detailed ground once the sphere detail is prepared (and back onto the
   * macro height field when it goes away); the closest zoom follows (8 m/px with detail, 40 without).
   */
  private syncGlobeGround(hf: GlobeHeightField): void {
    const gd = this.globeDetail;
    if (gd.version === this.globeDetailSeen) return;
    this.globeDetailSeen = gd.version;
    if (gd.fn && gd.params) {
      gd.fn.amp = this.globeDetailU.amp;
      this.globeGround = new GlobeDetailGround(gd.fn, hf, gd.boundsPad);
      this.globeCam.setGround(this.globeGround);
      this.globeCam.minMetresPerPixel = 8;
    } else if (this.globeGround) {
      this.globeGround = null;
      this.globeCam.setGround(hf);
      this.globeCam.minMetresPerPixel = 40;
    }
  }

  /** Advances the detail build and swaps in the detail-aware ground when a new version lands. */
  private stepDetail(): void {
    if (this.detail.building) this.detail.step(this.cam.moving ? 3 : 10);
    if (this.detail.version === this.detailSeen || !this.hf) return;
    this.detailSeen = this.detail.version;
    const src = this.detail.heightSources();
    if (!src) return;
    this.ground = new DetailGround(new HeightFn(src), this.hf, this.detail.boundsPad);
    this.cam.setGround(this.ground);
    // Creeks follow the detail terrain once its CPU copy exists.
    if (src.detail) this.setCreekWorld(this.creekWorld);
  }

  private ensureTargets(w: number, h: number): void {
    const gl = this.gl;
    const samples = Math.max(0, Math.min(this.quality.msaa, gl.getParameter(gl.MAX_SAMPLES) as number));
    if (this.fbo && w === this.fbW && h === this.fbH && samples === this.fbSamples) return;
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer();
      this.colorRb = gl.createRenderbuffer();
      this.depthRb = gl.createRenderbuffer();
    }
    // samples = 0 allocates single-sample storage; the blit to the canvas is then a plain copy.
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.colorRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbW = w;
    this.fbH = h;
    this.fbSamples = samples;
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
