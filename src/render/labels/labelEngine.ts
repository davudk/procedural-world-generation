import type { Landmark } from '../../shared/landmarks';
import { surfaceDir } from '../../shared/cube';
import type { GroundQuery, Vec3 } from '../camera/ground';
import { glyphChars, type GlyphMetrics, type GlyphSource } from './glyphs';
import { labelStyle, labelText, type LabelStyle } from './labelStyle';
import { LabelPlacer, type PlacementCandidate, type PlacementOptions } from './placement';
import { Projector, type LabelCamera } from './projector';
import { layoutAlongPath, textRun, type PathGlyphs, type TextRun } from './textLayout';

/** Seconds for a label to fade fully in or out. */
export const FADE_SEC = 0.25;
/**
 * Floats per glyph instance: centre x, y (CSS px), angle, style | quad ox, oy, w, h (CSS px, glyph-local)
 * | atlas rect x, y, w, h (px) | opacity, emphasis, highlight, scale (CSS px per atlas px).
 */
export const INSTANCE_FLOATS = 16;

/** Baseline sits this many em below the text's centre line. */
const BASELINE_EM = 0.35;
/** Half height of a collision box, em. */
const BOX_HALF_EM = 0.5;
const MAX_PATH_POINTS = 2000;
/** Raycasts per frame for the occlusion test, and frames a result stays valid. */
const OCCLUSION_BUDGET = 48;
const OCCLUSION_REFRESH = 8;
/** Tilt (rad) above which labels shrink with distance and the occlusion test runs. */
const TILT_MIN = 0.03;
/** A kept label survives until the view is this much coarser than its maxMpp (zoom hysteresis). */
const MPP_HYSTERESIS = 1.2;
/**
 * Globe: a point shows only while the eye is this far above its tangent plane (cosine of the angle
 * between the local up and the direction to the eye). Below 0 it is on the far side or behind the
 * horizon (the sea-level sphere lies under every tangent plane above it, so nothing on the planet
 * can be seen past it); below ~0.3 (72° off the view) text near the limb would hang out into space.
 */
export const GLOBE_MIN_FACING = 0.3;

/** What labels need of a rendered globe (GlobeGround satisfies it): planet-centred metres, +z north. */
export interface LabelGlobe {
  readonly radius: number;
  /** Rendered height above the sea-level radius (m, exaggerated) toward a direction. */
  heightAtDir(x: number, y: number, z: number): number;
  raycast(o: Vec3, d: Vec3): Vec3 | null;
}

export interface LabelFrame {
  cam: LabelCamera;
  /** Rendered ground of a flat map (heights already include the vertical exaggeration). */
  ground: GroundQuery | null;
  /**
   * Spheres: the rendered globe. Landmarks with a face are then placed at their (face, u, v) on it
   * (setLandmarks with the planet radius) and hidden on the far side.
   */
  globe?: LabelGlobe | null;
  dpr: number;
  timeSec: number;
  /** Only used to invalidate cached heights when it changes. */
  exaggeration: number;
}

interface Info {
  lm: Landmark;
  st: LabelStyle;
  text: string;
  glyphs: GlyphMetrics[];
  /** Glyph advances at the atlas font size. */
  adv: Float32Array;
  /** World position of the anchor (x east, y north) and its cached height. */
  wx: number;
  wy: number;
  z: number;
  zEpoch: number;
  /**
   * Globe: unit vector of the anchor and unit tangent of the text direction (rotated labels). The
   * path then holds unit vectors (3 per vertex) instead of world x, y pairs.
   */
  dir: Float64Array | null;
  tan: Float64Array | null;
  /** Path in world metres (x, y pairs), cached heights per vertex, sample vertex indices for culling. */
  path: Float64Array | null;
  pathZ: Float32Array | null;
  pathEpoch: number;
  samples: Int32Array | null;
  // Per-frame layout.
  sizePx: number;
  ax: number;
  ay: number;
  gx: Float32Array;
  gy: Float32Array;
  ga: Float32Array;
  boxes: Float32Array;
  run: TextRun | undefined;
  /** View version and size the layout was computed for (reused while the view is unchanged). */
  layoutView: number;
  layoutSize: number;
  hasLayout: boolean;
  occFrame: number;
  occluded: boolean;
}

interface State {
  info: Info;
  opacity: number;
  target: number;
}

export interface LabelStats {
  /** Landmarks passing the zoom / view tests this frame. */
  candidates: number;
  placed: number;
  /** Visible glyph quads. */
  glyphs: number;
  /** Candidate selection + placement (ms). */
  placeMs: number;
}

function wrap(a: number): number {
  const t = Math.PI * 2;
  a %= t;
  if (a > Math.PI) a -= t;
  else if (a <= -Math.PI) a += t;
  return a;
}

function priorityLess(a: Info, b: Info, hl: number | null): number {
  const fa = a.lm.id === hl, fb = b.lm.id === hl;
  if (fa !== fb) return fa ? 1 : -1;
  if (a.lm.hero !== b.lm.hero) return a.lm.hero ? 1 : -1;
  if (a.lm.importance !== b.lm.importance) return a.lm.importance - b.lm.importance;
  return b.lm.id - a.lm.id;
}

/**
 * Everything about labels except GL: candidate selection (zoom band, view, occlusion), layout (straight,
 * rotated, along paths), placement with hysteresis, fades, glyph instance data and hit testing. Pure
 * TypeScript over a GlyphSource, so it runs (and is timed) in node.
 */
export class LabelEngine {
  readonly placer: LabelPlacer;
  readonly proj = new Projector();
  stats: LabelStats = { candidates: 0, placed: 0, glyphs: 0, placeMs: 0 };
  instances = new Float32Array(INSTANCE_FLOATS * 1024);
  instanceCount = 0;

  private infos: Info[] = [];
  private byId = new Map<number, Info>();
  private states = new Map<number, State>();
  private highlightId: number | null = null;
  private frameNo = 0;
  private lastTime = -1;
  private epoch = 0;
  private lastGround: GroundQuery | LabelGlobe | null = null;
  private lastExag = NaN;
  private dpr = 1;
  private cands: PlacementCandidate[] = [];
  private candPool: PlacementCandidate[] = [];
  private candInfo: Info[] = [];
  private hits: Info[] = [];
  private drawnList: Landmark[] = [];
  private occBudget = 0;
  private frame: LabelFrame | null = null;
  private viewVersion = 0;
  private readonly viewKey = new Float64Array(16);
  /** Globe radius the landmarks were placed for (0: flat world coordinates). */
  private radius = 0;
  private readonly pt = new Float64Array(3);
  private scratch = new Float32Array(4096);
  private runs: number[] = [];

  constructor(private readonly glyphs: GlyphSource, placement: Partial<PlacementOptions> = {}) {
    this.placer = new LabelPlacer(placement);
  }

  /**
   * `worldM` is the flat map size (world y = worldM − map y). `radiusM` > 0 places the landmarks of a
   * sphere (those with a face) on a globe of that radius (shared/cube.ts surfaceDir).
   */
  setLandmarks(list: readonly Landmark[], worldM: number, radiusM = 0): void {
    this.radius = radiusM;
    this.infos = [];
    this.byId.clear();
    this.states.clear();
    this.hits = [];
    this.placer.reset();
    for (const lm of list) {
      if (!lm.name || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) continue;
      const globe = radiusM > 0;
      if (globe !== (lm.face !== undefined)) continue;
      const st = labelStyle(lm);
      const text = labelText(lm, st);
      const glyphs = glyphChars(text).map((ch) => this.glyphs.glyph(st.style, ch));
      if (glyphs.length === 0) continue;
      let path: Float64Array | null = null;
      let samples: Int32Array | null = null;
      let dir: Float64Array | null = null;
      let tan: Float64Array | null = null;
      if (globe) {
        dir = new Float64Array(3);
        surfaceDir(lm.face!, lm.x, lm.y, radiusM, dir);
        if (Number.isFinite(lm.angle)) {
          // The angle is in the anchor face's axes (+u east, −v north): its tangent by a small step.
          const q = new Float64Array(3);
          const e = 1e-4 * radiusM;
          surfaceDir(lm.face!, lm.x + Math.cos(lm.angle) * e, lm.y - Math.sin(lm.angle) * e, radiusM, q);
          tan = Float64Array.from([q[0] - dir[0], q[1] - dir[1], q[2] - dir[2]]);
          const l = Math.hypot(tan[0], tan[1], tan[2]) || 1;
          for (let k = 0; k < 3; k++) tan[k] /= l;
        }
      }
      if (st.mode === 'path' && lm.path && globe && lm.pathFace) {
        const n = Math.min(lm.pathFace.length, Math.floor(lm.path.length / 2));
        const stride = Math.max(1, Math.ceil(n / MAX_PATH_POINTS));
        const idx: number[] = [];
        for (let i = 0; i < n; i += stride) idx.push(i);
        if ((n - 1) % stride !== 0) idx.push(n - 1);
        path = new Float64Array(idx.length * 3);
        idx.forEach((i, k) => surfaceDir(lm.pathFace![i], lm.path![2 * i], lm.path![2 * i + 1], radiusM, path!, 3 * k));
        const pm = idx.length;
        const ns = Math.min(pm, 9);
        samples = new Int32Array(ns);
        for (let s = 0; s < ns; s++) samples[s] = Math.round(((pm - 1) * s) / Math.max(1, ns - 1));
      } else if (st.mode === 'path' && lm.path && !globe) {
        const n = Math.floor(lm.path.length / 2);
        const stride = Math.max(1, Math.ceil(n / MAX_PATH_POINTS));
        const m = Math.ceil(n / stride) + (((n - 1) % stride) !== 0 ? 1 : 0);
        path = new Float64Array(m * 2);
        let k = 0;
        for (let i = 0; i < n; i += stride) {
          path[k++] = lm.path[2 * i];
          path[k++] = worldM - lm.path[2 * i + 1];
        }
        if ((n - 1) % stride !== 0) {
          path[k++] = lm.path[2 * (n - 1)];
          path[k++] = worldM - lm.path[2 * (n - 1) + 1];
        }
        const pm = k / 2;
        const ns = Math.min(pm, 9);
        samples = new Int32Array(ns);
        for (let s = 0; s < ns; s++) samples[s] = Math.round(((pm - 1) * s) / Math.max(1, ns - 1));
        path = path.subarray(0, k);
      }
      const g = glyphs.length;
      const info: Info = {
        lm, st, text, glyphs, adv: Float32Array.from(glyphs, (gm) => gm.advance),
        wx: lm.x, wy: worldM - lm.y, z: 0, zEpoch: -1, dir, tan,
        path, pathZ: path ? new Float32Array(path.length / (globe ? 3 : 2)) : null, pathEpoch: -1, samples,
        sizePx: st.sizePx, ax: 0, ay: 0,
        gx: new Float32Array(g), gy: new Float32Array(g), ga: new Float32Array(g),
        boxes: new Float32Array(4), run: undefined,
        layoutView: -1, layoutSize: 0, hasLayout: false, occFrame: -1, occluded: false,
      };
      this.infos.push(info);
      this.byId.set(lm.id, info);
    }
    // Priority order (heroes, importance, id) so the placer rarely needs to sort.
    this.infos.sort((a, b) => -priorityLess(a, b, null));
  }

  highlight(id: number | null): void {
    this.highlightId = id;
  }

  /** True while labels are fading or newcomers wait for their stability frames (keep drawing). */
  get animating(): boolean {
    for (const s of this.states.values()) if (s.opacity !== s.target) return true;
    return this.placer.pending > 0;
  }

  /** Landmarks whose labels were drawn in the last frame (placed and fading). */
  get drawn(): readonly Landmark[] {
    return this.drawnList;
  }

  /** Topmost placed label whose boxes contain the CSS-px point (with a 3 px tolerance). */
  hitTest(sx: number, sy: number): Landmark | null {
    const t = 3;
    for (const info of this.hits) {
      const b = info.boxes;
      for (let i = 0; i < b.length; i += 4) {
        if (sx >= b[i] - t && sx <= b[i + 2] + t && sy >= b[i + 1] - t && sy <= b[i + 3] + t) return info.lm;
      }
    }
    return null;
  }

  /** Selects, places and fades labels for one frame and rebuilds the glyph instance data. */
  update(f: LabelFrame): void {
    const t0 = now();
    this.frame = f;
    this.frameNo++;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, f.timeSec - this.lastTime));
    this.lastTime = f.timeSec;
    this.dpr = Math.max(1, f.dpr || 1);
    const cam = f.cam;
    const proj = this.proj;
    proj.update(cam);
    const surface = f.globe ?? f.ground;
    if (surface !== this.lastGround || f.exaggeration !== this.lastExag) {
      this.epoch++;
      this.lastGround = surface;
      this.lastExag = f.exaggeration;
    }
    this.bumpView(cam);
    const W = cam.viewW, H = cam.viewH;
    const diag = Math.hypot(W, H);
    const centreMpp = cam.metresPerPixel();
    const tilted = cam.pitch > TILT_MIN;
    const hl = this.highlightId;
    const placer = this.placer;
    const cands = this.cands;
    cands.length = 0;
    this.candInfo.length = 0;
    this.occBudget = OCCLUSION_BUDGET;

    const forcedInfo = hl !== null ? this.byId.get(hl) : undefined;
    for (let n = forcedInfo ? -1 : 0; n < this.infos.length; n++) {
      const info = n < 0 ? forcedInfo! : this.infos[n];
      if (n >= 0 && info === forcedInfo) continue;
      const lm = info.lm;
      const forced = lm.id === hl;
      const kept = placer.wasPlaced(lm.id);
      const z = this.zOf(info, f);
      let ax = 0, ay = 0, depth = 0, ok = false;
      if (this.projectAnchor(info, z)) {
        ax = proj.sx;
        ay = proj.sy;
        depth = proj.depth;
        ok = ax >= 0 && ax <= W && ay >= 0 && ay <= H;
      }
      if (!ok && info.path && info.samples) {
        // The anchor is off screen: a river still qualifies when part of it is on screen.
        this.ensurePathZ(info, f);
        for (const s of info.samples) {
          if (this.projectVertex(info, s) && proj.sx >= 0 && proj.sx <= W && proj.sy >= 0 && proj.sy <= H) {
            ax = proj.sx;
            ay = proj.sy;
            depth = proj.depth;
            ok = true;
            break;
          }
        }
      }
      if (!ok) continue;
      const mpp = depth * proj.pxScale;
      if (!forced && mpp > lm.maxMpp * (kept ? MPP_HYSTERESIS : 1)) continue;
      // Far inside a huge feature its name means little (and would sit in a random spot).
      if (!forced && !info.path && lm.extentM / mpp > 3 * diag) continue;
      const k = tilted ? Math.min(1.08, Math.max(0.72, Math.pow(centreMpp / mpp, 0.35))) : 1;
      info.sizePx = info.st.sizePx * k;
      const c = this.candPool[cands.length] ?? (this.candPool[cands.length] = { id: 0, hero: false, importance: 0, ax: 0, ay: 0, boxes: null });
      c.id = lm.id;
      c.hero = lm.hero;
      c.importance = lm.importance;
      c.ax = ax;
      c.ay = ay;
      c.boxes = null;
      c.force = forced;
      cands.push(c);
      this.candInfo.push(info);
    }

    const placed = placer.place(cands, W, H, (c, i) => {
      const info = this.candInfo[i];
      if (!info.path && this.occluded(info, f, tilted)) return null;
      if (!this.layout(info)) return null;
      if (info.path) {
        c.ax = info.ax;
        c.ay = info.ay;
      }
      return info.boxes;
    });

    // Fades.
    this.hits.length = 0;
    const placedIds = new Set<number>();
    for (const p of placed) {
      const info = this.candInfo[p.index];
      placedIds.add(p.id);
      this.hits.push(info);
      let s = this.states.get(p.id);
      if (!s) this.states.set(p.id, (s = { info, opacity: 0, target: 1 }));
      s.target = 1;
    }
    const step = dt / FADE_SEC;
    const live: State[] = [];
    for (const [id, s] of this.states) {
      if (!placedIds.has(id)) s.target = 0;
      s.opacity = s.target > s.opacity ? Math.min(s.target, s.opacity + step) : Math.max(s.target, s.opacity - step);
      if (s.target === 0 && s.opacity <= 0) this.states.delete(id);
      else live.push(s);
    }
    live.sort((a, b) => priorityLess(a.info, b.info, hl));
    this.stats.candidates = cands.length;
    this.stats.placed = placed.length;
    this.stats.placeMs = now() - t0;
    this.buildInstances(live);
    this.frame = null;
  }

  // ---- Internals ---------------------------------------------------------------------------------

  /** Increments the view version when anything that affects screen positions changed. */
  private bumpView(cam: LabelCamera): void {
    const p = this.proj, k = this.viewKey;
    const v = [p.ex, p.ey, p.ez, cam.pitch, cam.bearing, cam.fovY, cam.viewW, cam.viewH, this.dpr, this.epoch, p.fx, p.fy, p.fz, p.rx, p.ry, p.rz];
    let changed = false;
    for (let i = 0; i < v.length; i++) {
      if (k[i] !== v[i]) {
        k[i] = v[i];
        changed = true;
      }
    }
    if (changed) this.viewVersion++;
  }

  private zOf(info: Info, f: LabelFrame): number {
    if (info.zEpoch !== this.epoch) {
      if (info.dir) {
        const d = info.dir;
        info.z = f.globe ? f.globe.heightAtDir(d[0], d[1], d[2]) : 0;
      } else if (f.ground) {
        const s = f.ground.size;
        info.z = f.ground.heightAt(Math.min(s, Math.max(0, info.wx)), Math.min(s, Math.max(0, info.wy)));
      } else info.z = 0;
      if (!Number.isFinite(info.z)) info.z = 0;
      info.zEpoch = this.epoch;
    }
    return info.z;
  }

  private ensurePathZ(info: Info, f: LabelFrame): void {
    if (info.pathEpoch === this.epoch || !info.path || !info.pathZ) return;
    const p = info.path, pz = info.pathZ;
    if (info.dir) {
      for (let i = 0; i < pz.length; i++) {
        const h = f.globe ? f.globe.heightAtDir(p[3 * i], p[3 * i + 1], p[3 * i + 2]) : 0;
        pz[i] = Number.isFinite(h) ? h : 0;
      }
    } else if (f.ground) {
      const s = f.ground.size;
      for (let i = 0; i < pz.length; i++) {
        const h = f.ground.heightAt(Math.min(s, Math.max(0, p[2 * i])), Math.min(s, Math.max(0, p[2 * i + 1])));
        pz[i] = Number.isFinite(h) ? h : 0;
      }
    } else pz.fill(0);
    info.pathEpoch = this.epoch;
  }

  /**
   * Projects a globe point (unit vector d at height z) when it faces the eye (GLOBE_MIN_FACING),
   * else false: far-side and behind-the-horizon points never reach the screen.
   */
  private projectDir(dx: number, dy: number, dz: number, z: number): boolean {
    const p = this.proj;
    const r = this.radius + z;
    const x = dx * r, y = dy * r, w = dz * r;
    const ex = p.ex - x, ey = p.ey - y, ez = p.ez - w;
    const up = ex * dx + ey * dy + ez * dz;
    if (!(up > GLOBE_MIN_FACING * Math.hypot(ex, ey, ez))) return false;
    return p.project(x, y, w);
  }

  /** Projects the anchor at height z (flat world coordinates, or its globe position). */
  private projectAnchor(info: Info, z: number): boolean {
    const d = info.dir;
    return d ? this.projectDir(d[0], d[1], d[2], z) : this.proj.project(info.wx, info.wy, z);
  }

  /** Projects path vertex i at its cached height. */
  private projectVertex(info: Info, i: number): boolean {
    const p = info.path!, pz = info.pathZ!;
    return info.dir ? this.projectDir(p[3 * i], p[3 * i + 1], p[3 * i + 2], pz[i]) : this.proj.project(p[2 * i], p[2 * i + 1], pz[i]);
  }

  /** World position of the anchor at height z, and its up vector. */
  private anchorWorld(info: Info, z: number, out: Float64Array): [number, number, number] {
    const d = info.dir;
    if (!d) {
      out[0] = info.wx;
      out[1] = info.wy;
      out[2] = z;
      return [0, 0, 1];
    }
    const r = this.radius + z;
    out[0] = d[0] * r;
    out[1] = d[1] * r;
    out[2] = d[2] * r;
    return [d[0], d[1], d[2]];
  }

  /**
   * Cheap terrain occlusion for tilted views: a ray from the eye towards the anchor; occluded when the
   * terrain is hit clearly before it. Budgeted per frame, results reused for a few frames.
   */
  private occluded(info: Info, f: LabelFrame, tilted: boolean): boolean {
    if (!tilted) return false;
    const ground = info.dir ? f.globe : f.ground;
    if (!ground) return false;
    if (info.occFrame >= 0 && this.frameNo - info.occFrame < OCCLUSION_REFRESH) return info.occluded;
    if (this.occBudget <= 0) return info.occFrame >= 0 ? info.occluded : false;
    this.occBudget--;
    const p = this.proj;
    const a = this.pt;
    const [ux, uy, uz] = this.anchorWorld(info, info.z, a);
    const dist0 = Math.hypot(a[0] - p.ex, a[1] - p.ey, a[2] - p.ez);
    const lift = Math.max(5, 0.002 * dist0);
    const dx = a[0] + ux * lift - p.ex, dy = a[1] + uy * lift - p.ey, dz = a[2] + uz * lift - p.ez;
    const dist = Math.hypot(dx, dy, dz);
    let occ = false;
    if (dist > 1) {
      const hit = ground.raycast({ x: p.ex, y: p.ey, z: p.ez }, { x: dx / dist, y: dy / dist, z: dz / dist });
      if (hit) occ = Math.hypot(hit.x - p.ex, hit.y - p.ey, hit.z - p.ez) < dist * 0.985 - 20;
    }
    info.occFrame = this.frameNo;
    info.occluded = occ;
    return occ;
  }

  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private textRunFor(info: Info): TextRun {
    info.run = textRun(info.adv, info.st.letterSpacingEm * info.sizePx, info.run, info.sizePx / this.glyphs.fontPx);
    return info.run;
  }

  /** Lays out glyph centres and collision boxes for the current frame; false when it cannot be shown. */
  private layout(info: Info): boolean {
    if (info.layoutView === this.viewVersion && info.layoutSize === info.sizePx) return info.hasLayout;
    info.layoutView = this.viewVersion;
    info.layoutSize = info.sizePx;
    info.hasLayout = info.path ? this.layoutPath(info) : this.layoutAnchor(info);
    return info.hasLayout;
  }

  private layoutAnchor(info: Info): boolean {
    const f = this.frame!;
    const p = this.proj;
    const z = this.zOf(info, f);
    if (!this.projectAnchor(info, z)) return false;
    const ax = p.sx, ay = p.sy, depth = p.depth;
    const s = info.sizePx;
    const run = this.textRunFor(info);
    const L = run.length;
    const g = info.glyphs.length;
    const off = info.st.offsetEm * s;
    info.ax = ax;
    info.ay = ay;
    if (info.st.mode === 'rotated') {
      // Text direction: map angle (0 = east, counter-clockwise on the north-up map) projected to the screen.
      const r = Math.max(1, 40 * depth * p.pxScale);
      let th = 0;
      let ok: boolean;
      if (info.tan) {
        // Globe: along the tangent of the anchor face's direction.
        const a = this.pt;
        this.anchorWorld(info, z, a);
        const t = info.tan;
        ok = p.project(a[0] + t[0] * r, a[1] + t[1] * r, a[2] + t[2] * r);
      } else ok = p.project(info.wx + Math.cos(info.lm.angle) * r, info.wy + Math.sin(info.lm.angle) * r, z);
      if (ok) {
        th = Math.atan2(p.sy - ay, p.sx - ax);
        if (Math.cos(th) < 0) th = wrap(th + Math.PI);
      }
      const c = Math.cos(th), sn = Math.sin(th);
      // Centre line point: anchor shifted along the screen normal (−sin, cos) by the offset.
      const cx = ax - sn * off, cy = ay + c * off;
      for (let i = 0; i < g; i++) {
        const u = run.centres[i] - L / 2;
        info.gx[i] = cx + c * u;
        info.gy[i] = cy + sn * u;
        info.ga[i] = th;
      }
      this.chunkBoxes(info, 3, run);
      return true;
    }
    const baseline = this.snap(ay + off + BASELINE_EM * s);
    const cy = baseline - BASELINE_EM * s;
    const x0 = this.snap(ax - L / 2);
    for (let i = 0; i < g; i++) {
      info.gx[i] = x0 + run.centres[i];
      info.gy[i] = cy;
      info.ga[i] = 0;
    }
    if (info.boxes.length !== 4) info.boxes = new Float32Array(4);
    info.boxes[0] = x0;
    info.boxes[1] = cy - BOX_HALF_EM * s;
    info.boxes[2] = x0 + L;
    info.boxes[3] = cy + BOX_HALF_EM * s;
    return true;
  }

  /** Boxes covering groups of `per` glyphs (rotated rectangles → axis-aligned bounds). */
  private chunkBoxes(info: Info, per: number, run: TextRun): void {
    const g = info.glyphs.length;
    const n = Math.ceil(g / per);
    if (info.boxes.length !== n * 4) info.boxes = new Float32Array(n * 4);
    const hh = BOX_HALF_EM * info.sizePx;
    for (let b = 0; b < n; b++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = b * per; i < Math.min(g, (b + 1) * per); i++) {
        const c = Math.abs(Math.cos(info.ga[i])), s = Math.abs(Math.sin(info.ga[i]));
        const hl = run.widths[i] / 2 + 0.5 * info.st.letterSpacingEm * info.sizePx;
        const ex = c * hl + s * hh, ey = s * hl + c * hh;
        x0 = Math.min(x0, info.gx[i] - ex);
        x1 = Math.max(x1, info.gx[i] + ex);
        y0 = Math.min(y0, info.gy[i] - ey);
        y1 = Math.max(y1, info.gy[i] + ey);
      }
      info.boxes[b * 4] = x0;
      info.boxes[b * 4 + 1] = y0;
      info.boxes[b * 4 + 2] = x1;
      info.boxes[b * 4 + 3] = y1;
    }
  }

  /** Curved placement along the projected path: the straightest on-screen stretch that fits. */
  private layoutPath(info: Info): boolean {
    const f = this.frame!;
    const p = this.proj;
    this.ensurePathZ(info, f);
    const n = info.pathZ!.length;
    if (this.scratch.length < n * 2) this.scratch = new Float32Array(n * 2);
    const pts = this.scratch;
    const W = p.w, H = p.h, inset = 4;
    // Split the projected path into on-screen runs, dropping vertices closer than 2 px.
    const runs = this.runs;
    runs.length = 0;
    let k = 0, start = 0;
    for (let i = 0; i < n; i++) {
      const vis = this.projectVertex(info, i) && p.sx >= inset && p.sx <= W - inset && p.sy >= inset && p.sy <= H - inset;
      if (!vis) {
        if (k - start >= 2) runs.push(start, k);
        start = k;
        continue;
      }
      if (k > start && i < n - 1) {
        const dx = p.sx - pts[2 * k - 2], dy = p.sy - pts[2 * k - 1];
        if (dx * dx + dy * dy < 4) continue;
      }
      pts[2 * k] = p.sx;
      pts[2 * k + 1] = p.sy;
      k++;
    }
    if (k - start >= 2) runs.push(start, k);
    if (runs.length === 0) return false;
    const run = this.textRunFor(info);
    let best: PathGlyphs | null = null;
    for (let r = 0; r < runs.length; r += 2) {
      const a = runs[r], b = runs[r + 1];
      const res = layoutAlongPath(pts.subarray(2 * a, 2 * b), b - a, run);
      if (res && (!best || res.cost < best.cost)) best = res;
    }
    if (!best) return false;
    info.gx.set(best.x);
    info.gy.set(best.y);
    info.ga.set(best.angle);
    const mid = Math.floor(info.glyphs.length / 2);
    info.ax = best.x[mid];
    info.ay = best.y[mid];
    this.chunkBoxes(info, 2, run);
    return true;
  }

  private buildInstances(live: State[]): void {
    let total = 0;
    for (const s of live) total += s.info.glyphs.length;
    this.drawnList = [];
    if (this.instances.length < total * INSTANCE_FLOATS) this.instances = new Float32Array(Math.ceil(total * 1.5) * INSTANCE_FLOATS);
    const out = this.instances;
    const fontPx = this.glyphs.fontPx;
    let o = 0, count = 0;
    for (const s of live) {
      const info = s.info;
      // Labels fading out keep their last layout when it can no longer be computed.
      if (info.layoutView !== this.viewVersion) {
        const had = info.hasLayout;
        // On a globe a label that turned to the far side goes at once (its last layout would float there).
        if (!this.layout(info) && had && !info.dir) info.hasLayout = true;
      }
      if (!info.hasLayout) continue;
      this.drawnList.push(info.lm);
      const size = info.sizePx;
      const scale = size / fontPx;
      const style = info.st.style;
      const emph = info.st.emphasis;
      const hl = info.lm.id === this.highlightId ? 1 : 0;
      const opacity = s.opacity * s.opacity * (3 - 2 * s.opacity);
      const oy0 = BASELINE_EM * size;
      for (let i = 0; i < info.glyphs.length; i++) {
        const gm = info.glyphs[i];
        if (gm.aw === 0) continue;
        out[o] = info.gx[i];
        out[o + 1] = info.gy[i];
        out[o + 2] = info.ga[i];
        out[o + 3] = style;
        out[o + 4] = -0.5 * gm.advance * scale + gm.left * scale;
        out[o + 5] = oy0 + gm.top * scale;
        out[o + 6] = gm.aw * scale;
        out[o + 7] = gm.ah * scale;
        out[o + 8] = gm.ax;
        out[o + 9] = gm.ay;
        out[o + 10] = gm.aw;
        out[o + 11] = gm.ah;
        out[o + 12] = opacity;
        out[o + 13] = emph;
        out[o + 14] = hl;
        out[o + 15] = scale;
        o += INSTANCE_FLOATS;
        count++;
      }
    }
    this.instanceCount = count;
    this.stats.glyphs = count;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
