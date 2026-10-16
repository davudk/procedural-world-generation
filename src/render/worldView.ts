import type { Layer, RiverGraph } from '../shared/protocol';
import type { GroundQuery, Vec3 } from './camera/ground';
import { OrbitCamera } from './camera/orbitCamera';
import { HeightField, prepareWater } from './heightField';
import { CdlodSelector, GRID } from './terrain/cdlod';
import type { Palette } from './terrain/biomeLut';
import { DetailUniforms } from './glsl/detail';
import { DetailGround, HeightFn } from './height/heightFn';
import { HorizonPass } from './lighting/horizon';
import { DetailMap, type DetailInput } from './terrain/detail/detailMap';
import { SkyPass } from './lighting/sky';
import { TerrainPass, type SurfaceLayers } from './terrain/terrainPass';
import { CreekManager } from './water/creeks/creekManager';
import { RiverPass } from './water/rivers';

const MSAA = 4;
const HAZE_COLOR = [0.62, 0.70, 0.78] as const;

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

/**
 * The 3D world view (M2): CDLOD terrain with a water lid, orbit camera, reversed-Z where
 * EXT_clip_control exists, and 4× MSAA into a float-depth framebuffer that is blitted to the canvas.
 */
export class WorldView {
  readonly gl: WebGL2RenderingContext;
  readonly cam: OrbitCamera;
  hf: HeightField | null = null;
  readonly reversedZ: boolean;
  /** Geometric vertical exaggeration (user setting). */
  exaggeration = 1.5;
  nodes = 0;
  private readonly selector = new CdlodSelector();
  private readonly terrain: TerrainPass;
  readonly rivers: RiverPass;
  readonly creekPass: RiverPass;
  readonly creeks = new CreekManager();
  private readonly horizon: HorizonPass;
  private readonly sky: SkyPass;
  private readonly detail: DetailMap;
  private readonly detailU: DetailUniforms;
  private detailSeen = -1;
  private ground: DetailGround | null = null;
  private creekWorld: { elevation: Layer; waterClass: Layer; discharge: Layer; rivers: RiverGraph; seed: number } | null = null;
  private readonly viewProj = new Float32Array(16);
  private readonly planes = new Float64Array(24);
  private fbo: WebGLFramebuffer | null = null;
  private colorRb: WebGLRenderbuffer | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
  private fbW = 0;
  private fbH = 0;
  private dpr = 1;
  private fittedSize = -1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // alpha: true makes the default framebuffer RGBA8, matching the MSAA colour buffer: a multisample
    // resolve blit requires identical formats. Everything is drawn opaque.
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, depth: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const clip = gl.getExtension('EXT_clip_control') as { clipControlEXT(o: number, d: number): void; LOWER_LEFT_EXT: number; ZERO_TO_ONE_EXT: number } | null;
    if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.ZERO_TO_ONE_EXT);
    this.reversedZ = clip !== null;
    this.cam = new OrbitCamera(new FlatGround(1024e3));
    this.cam.reversedZ = this.reversedZ;
    this.terrain = new TerrainPass(gl);
    this.rivers = new RiverPass(gl);
    this.creekPass = new RiverPass(gl);
    // Creeks fade in at the zooms the camera can reach (the manager must use the same constant).
    this.creekPass.lodC = 35;
    this.creeks.lodC = 35;
    this.horizon = new HorizonPass(gl);
    this.sky = new SkyPass(gl);
    this.detail = new DetailMap(gl);
    this.detailU = new DetailUniforms(this.detail);
  }

  /** Starts building the close-zoom detail map (time-sliced in draw()). */
  buildDetail(input: DetailInput): void {
    this.ground = null;
    this.detail.build(input);
  }

  /** Terrain elevation plus optional water level / water class rasters (same grid). */
  setTerrain(layer: Layer, water: Layer | null = null, wclass: Layer | null = null): void {
    const prepared = water !== null && water.w === layer.w ? prepareWater(layer, water, wclass && wclass.w === layer.w ? wclass : null) : null;
    const hf = new HeightField(layer, prepared?.level ?? null);
    hf.exaggeration = this.exaggeration;
    this.hf = hf;
    this.cam.setGround(hf);
    this.terrain.setTerrain(layer, prepared);
    this.horizon.setSurface(hf.surface, hf.n, hf.size);
    if (this.fittedSize !== hf.size) {
      this.fittedSize = hf.size;
      this.cam.fitWorld();
    }
  }

  setExaggeration(x: number): void {
    this.exaggeration = x;
    if (this.hf) this.hf.exaggeration = x;
  }

  setSurface(s: SurfaceLayers | null): void {
    this.terrain.setSurface(s);
  }

  setPalette(p: Palette | 'hypsometric'): void {
    this.terrain.palette = p;
  }

  /**
   * Inputs for close-zoom creeks: hydro-stage layers on the terrain grid plus the macro river graph.
   * `heightAt` must not depend on the view (research 07 §2.1).
   */
  setCreekWorld(w: { elevation: Layer; waterClass: Layer; discharge: Layer; rivers: RiverGraph; seed: number } | null): void {
    this.creekWorld = w;
    const hf = this.hf;
    if (!w || !hf || w.elevation.w !== hf.n) {
      this.creeks.setWorld(null, () => 0);
      this.creekPass.setRivers(null, 0);
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
    this.creekPass.setRivers(null, size);
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

  setRivers(graph: RiverGraph | null): void {
    this.rivers.setRivers(graph, this.hf?.size ?? 0);
  }

  setDrape(layer: Layer | null): void {
    this.terrain.setDrape(layer);
  }

  /** Resizes the drawing buffer to CSS size × DPR and tells the camera. */
  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.cam.viewW = w;
    this.cam.viewH = h;
    const bw = Math.max(1, Math.round(w * this.dpr));
    const bh = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  draw(timeSec: number): void {
    const gl = this.gl;
    this.stepDetail();
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.ensureTargets(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(HAZE_COLOR[0] * 0.25, HAZE_COLOR[1] * 0.27, HAZE_COLOR[2] * 0.32, 1);
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
      this.nodes = this.selector.select(hf, eye, eye, this.planes, { maxDepth, vertexPx: 3, pxPerRad, boundsPad });
      if (this.ground) this.ground.pxFoot = Math.max(cam.metresPerPixel(), hf.size / 2 ** maxDepth / GRID);
      const altitude = Math.max(1, eye.z - hf.heightAt(eye.x, eye.y));
      const az = cam.bearing - Math.PI / 4; // light from the top-left of the screen
      const el = (40 * Math.PI) / 180;
      const tilt = Math.sin(cam.pitch);
      const sun: [number, number, number] = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
      // Shadows read best with a little more relief than the geometry at far zoom.
      this.horizon.update(sun, this.exaggeration * 1.5);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.DEPTH_TEST);
      this.sky.draw(this.viewProj, HAZE_COLOR, sun, this.reversedZ);
      gl.enable(gl.DEPTH_TEST);
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
        sun,
        // Aerial perspective scales with altitude: low tilted views fade the horizon, high views stay clear.
        haze: (tilt * tilt * 1.2) / (altitude * 25) + 1e-9,
        hazeColor: HAZE_COLOR,
        time: timeSec,
      });
      const riverFrame = {
        viewProj: this.viewProj,
        origin: eye,
        exaggeration: this.exaggeration,
        pxScale: (2 * Math.tan(cam.fovY / 2)) / Math.max(1, cam.viewH),
        time: timeSec,
      };
      this.updateCreeks();
      this.creekPass.draw(riverFrame);
      this.rivers.draw(riverFrame);
      gl.disable(gl.DEPTH_TEST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    if (this.fbo && w === this.fbW && h === this.fbH) return;
    const gl = this.gl;
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer();
      this.colorRb = gl.createRenderbuffer();
      this.depthRb = gl.createRenderbuffer();
    }
    const samples = Math.min(MSAA, gl.getParameter(gl.MAX_SAMPLES) as number);
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
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
