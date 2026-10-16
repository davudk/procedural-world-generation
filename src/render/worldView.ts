import type { Layer, RiverGraph } from '../shared/protocol';
import type { GroundQuery, Vec3 } from './camera/ground';
import { OrbitCamera } from './camera/orbitCamera';
import { HeightField, prepareWater } from './heightField';
import { CdlodSelector } from './terrain/cdlod';
import { TerrainPass } from './terrain/terrainPass';
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
  }

  /** Terrain elevation plus optional water level / water class rasters (same grid). */
  setTerrain(layer: Layer, water: Layer | null = null, wclass: Layer | null = null): void {
    const prepared = water !== null && water.w === layer.w ? prepareWater(layer, water, wclass && wclass.w === layer.w ? wclass : null) : null;
    const hf = new HeightField(layer, prepared?.level ?? null);
    hf.exaggeration = this.exaggeration;
    this.hf = hf;
    this.cam.setGround(hf);
    this.terrain.setTerrain(layer, prepared);
    if (this.fittedSize !== hf.size) {
      this.fittedSize = hf.size;
      this.cam.fitWorld();
    }
  }

  setExaggeration(x: number): void {
    this.exaggeration = x;
    if (this.hf) this.hf.exaggeration = x;
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
      this.nodes = this.selector.select(hf, eye, eye, this.planes, { maxDepth: 7, vertexPx: 3, pxPerRad, boundsPad: 50 });
      const altitude = Math.max(1, eye.z - hf.heightAt(eye.x, eye.y));
      const az = cam.bearing - Math.PI / 4; // light from the top-left of the screen
      const el = (40 * Math.PI) / 180;
      const tilt = Math.sin(cam.pitch);
      this.terrain.draw({
        viewProj: this.viewProj,
        origin: eye,
        instances: this.selector.instances,
        count: this.nodes,
        exaggeration: this.exaggeration,
        normalExaggeration: this.exaggeration * (1.4 + 5.0 * smoothstep(5e3, 6e5, altitude)),
        sun: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)],
        haze: (tilt * tilt * 1.6) / hf.size + 1e-8,
        hazeColor: HAZE_COLOR,
        time: timeSec,
      });
      this.rivers.draw({
        viewProj: this.viewProj,
        origin: eye,
        exaggeration: this.exaggeration,
        pxScale: (2 * Math.tan(cam.fovY / 2)) / Math.max(1, cam.viewH),
        time: timeSec,
      });
      gl.disable(gl.DEPTH_TEST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
