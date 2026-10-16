import type { GroundQuery, Vec3 } from './ground';
import { lookAt, mul, perspective, perspectiveReversedInfinite } from '../math/mat4';

const DEG = Math.PI / 180;
export const MAX_PITCH = 60 * DEG;
const MIN_DISTANCE = 100;      // m, eye → target
const MIN_CLEARANCE = 30;      // m, eye above the ground below it
const FIT_MARGIN = 1.1;
const MAX_DIST_OVER_FIT = 1.3;
const TARGET_MARGIN = 0.1;     // of the visible width, beyond the world edge
const MAX_REACH_WORLDS = 2;    // pitch is limited so the top screen edge sees at most this many world sizes past the target
const ZOOM_EASE = 18;          // 1/s, exponential approach of eased zoom
const BEARING_EASE = 10;       // 1/s, eased north-up
const AUTO_TILT_HIGH = 200_000; // m: no tilt at or above this distance
const AUTO_TILT_LOW = 3_000;    // m: full tilt at or below
const AUTO_TILT_MAX = 42 * DEG;
const AUTO_TILT_DECAY = 3;     // a manual pitch offset decays by e^-3 per e-fold of zoom
const FLIGHT_RHO = 1.42;       // van Wijk & Nuij curvature (√2 ≈ their recommended value)

/** Automatic pitch for an eye → target distance: 0 above 200 km, smoothly rising to 42° at 3 km (research 04 §7.1). */
export function autoPitch(distance: number): number {
  const t = Math.log(AUTO_TILT_HIGH / distance) / Math.log(AUTO_TILT_HIGH / AUTO_TILT_LOW);
  const c = Math.min(1, Math.max(0, t));
  return AUTO_TILT_MAX * c * c * (3 - 2 * c);
}

interface Basis {
  /** Screen right. */
  r: Vec3;
  /** Screen up. */
  u: Vec3;
  /** View direction (eye → target). */
  f: Vec3;
}

interface Flight {
  x0: number;
  y0: number;
  dx: number; // unit direction of travel
  dy: number;
  u1: number; // travel length (m)
  w0: number;
  w1: number;
  r0: number;
  S: number;  // path length in van Wijk's s units
  kw: number; // visible width per metre of distance
  d1: number;
  x1: number;
  y1: number;
  T: number;  // duration (s)
  t: number;
}

/**
 * Orbit camera over the 3D world (research 04 §7, PLAN.md §8). All state is float64; the GPU gets
 * camera-relative matrices (`viewProjRelative`). World conventions: see ground.ts (x east, y north, z up, metres).
 *
 * - `pitch`: 0 = looking straight down, up to MAX_PITCH (60°) towards the horizon.
 * - `bearing`: compass heading the camera faces; 0 = north up, positive clockwise (π/2 = east up). The map
 *   content rotates counter-clockwise on screen as bearing grows.
 * - Screen coordinates (sx, sy) are CSS px from the canvas top-left, y down.
 */
export class OrbitCamera {
  /** Ground point the camera orbits (re-seated on the terrain each update). */
  readonly target: Vec3 = { x: 0, y: 0, z: 0 };
  distance = 1000;
  pitch = 0;
  bearing = 0;
  fovY = 32 * DEG;
  viewW = 1;
  viewH = 1;
  /** Set by the renderer when EXT_clip_control is available (reversed-Z, infinite far, ZERO_TO_ONE depth). */
  reversedZ = false;
  /** Pitch follows `autoPitch(distance)` while zooming; turned off by an explicit tilt, back on by `fitWorld`. */
  autoTilt = true;

  private ground: GroundQuery;
  private zoomPending = 0; // ln(distance factor) still to apply
  private zoomAnchor: Vec3 | null = null;
  private bearingGoal: number | null = null;
  private flight: Flight | null = null;

  constructor(ground: GroundQuery) {
    this.ground = ground;
    this.fitWorld();
  }

  /** Swaps the terrain (new generation). Refits when the world size changed, otherwise keeps the view. */
  setGround(g: GroundQuery): void {
    const resized = g.size !== this.ground.size;
    this.ground = g;
    if (resized) this.fitWorld();
    else {
      this.reseat();
      this.settle();
    }
  }

  /** True while an eased zoom, north-up or flight is still running (the renderer must keep drawing). */
  get moving(): boolean {
    return this.flight !== null || this.zoomPending !== 0 || this.bearingGoal !== null;
  }

  eye(): Vec3 {
    const sp = Math.sin(this.pitch) * this.distance;
    return {
      x: this.target.x - sp * Math.sin(this.bearing),
      y: this.target.y - sp * Math.cos(this.bearing),
      z: this.target.z + this.distance * Math.cos(this.pitch),
    };
  }

  private basis(): Basis {
    const sb = Math.sin(this.bearing), cb = Math.cos(this.bearing);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    return {
      r: { x: cb, y: -sb, z: 0 },
      u: { x: sb * cp, y: cb * cp, z: sp },
      f: { x: sb * sp, y: cb * sp, z: -cp },
    };
  }

  // ---- Projection -------------------------------------------------------------------------------

  /** Altitude of the eye above the ground below it (≥ 1 m). */
  clearance(): number {
    const e = this.eye();
    return Math.max(1, e.z - this.groundAt(e.x, e.y));
  }

  near(): number {
    const c = this.clearance();
    if (this.reversedZ) return Math.max(1, Math.min(0.0005 * c, 0.5 * c));
    const near = Math.min(5000, Math.max(1, 0.3 * c));
    return Math.max(near, this.farStandard(near) / 1e5);
  }

  far(): number {
    if (this.reversedZ) return Infinity;
    return this.farStandard(Math.min(5000, Math.max(1, 0.3 * this.clearance())));
  }

  /** Farthest world corner (at or below sea level) from the eye, capped at 1e5 × near. */
  private farStandard(near: number): number {
    const e = this.eye();
    const s = this.ground.size;
    const zLow = Math.min(0, this.target.z) - 1000;
    let far = 0;
    for (const x of [0, s]) for (const y of [0, s]) far = Math.max(far, Math.hypot(x - e.x, y - e.y, zLow - e.z));
    return Math.max(2 * near, Math.min(far * 1.05, 1e5 * near));
  }

  /** World → clip with the translation removed: feed (p − origin) as positions. Column-major, 16 floats. */
  viewProjRelative(out: Float32Array, origin: Vec3): Float32Array {
    const e = this.eye();
    const { u } = this.basis();
    const view = lookAt(
      new Float64Array(16),
      { x: e.x - origin.x, y: e.y - origin.y, z: e.z - origin.z },
      { x: this.target.x - origin.x, y: this.target.y - origin.y, z: this.target.z - origin.z },
      u,
    );
    const aspect = this.viewW / this.viewH;
    const proj = new Float64Array(16);
    if (this.reversedZ) perspectiveReversedInfinite(proj, this.fovY, aspect, this.near());
    else perspective(proj, this.fovY, aspect, this.near(), this.far());
    out.set(mul(proj, proj, view));
    return out;
  }

  /**
   * Frustum planes (left, right, bottom, top, near, far) as (a, b, c, d) with unit normals pointing inside:
   * a point p (relative to `origin`) is inside when a·x + b·y + c·z + d ≥ 0. The far plane has d = +Infinity
   * when reversedZ (infinite far).
   */
  frustumPlanesRelative(out: Float64Array, origin: Vec3): Float64Array {
    const e = this.eye();
    const ex = e.x - origin.x, ey = e.y - origin.y, ez = e.z - origin.z;
    const { r, u, f } = this.basis();
    const ty = Math.tan(this.fovY / 2);
    const tx = ty * (this.viewW / this.viewH);
    const set = (i: number, nx: number, ny: number, nz: number, px: number, py: number, pz: number): void => {
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      out[i * 4] = nx;
      out[i * 4 + 1] = ny;
      out[i * 4 + 2] = nz;
      out[i * 4 + 3] = -(nx * px + ny * py + nz * pz);
    };
    set(0, r.x + f.x * tx, r.y + f.y * tx, r.z + f.z * tx, ex, ey, ez);
    set(1, -r.x + f.x * tx, -r.y + f.y * tx, -r.z + f.z * tx, ex, ey, ez);
    set(2, u.x + f.x * ty, u.y + f.y * ty, u.z + f.z * ty, ex, ey, ez);
    set(3, -u.x + f.x * ty, -u.y + f.y * ty, -u.z + f.z * ty, ex, ey, ez);
    const n = this.near();
    set(4, f.x, f.y, f.z, ex + f.x * n, ey + f.y * n, ez + f.z * n);
    const far = this.far();
    if (Number.isFinite(far)) set(5, -f.x, -f.y, -f.z, ex + f.x * far, ey + f.y * far, ez + f.z * far);
    else {
      out[20] = -f.x;
      out[21] = -f.y;
      out[22] = -f.z;
      out[23] = Infinity;
    }
    return out;
  }

  /** Ray from the eye through a screen point (d is unit length). */
  screenRay(sx: number, sy: number): { o: Vec3; d: Vec3 } {
    const { r, u, f } = this.basis();
    const ty = Math.tan(this.fovY / 2);
    const nx = (2 * sx / this.viewW - 1) * ty * (this.viewW / this.viewH);
    const ny = (1 - 2 * sy / this.viewH) * ty;
    const dx = f.x + r.x * nx + u.x * ny, dy = f.y + r.y * nx + u.y * ny, dz = f.z + r.z * nx + u.z * ny;
    const l = Math.hypot(dx, dy, dz);
    return { o: this.eye(), d: { x: dx / l, y: dy / l, z: dz / l } };
  }

  /** Screen position (CSS px) of a world point, or null when it is behind the eye. */
  project(p: Vec3): { sx: number; sy: number } | null {
    const e = this.eye();
    const { r, u, f } = this.basis();
    const px = p.x - e.x, py = p.y - e.y, pz = p.z - e.z;
    const depth = px * f.x + py * f.y + pz * f.z;
    if (depth <= 1e-9) return null;
    const ty = Math.tan(this.fovY / 2);
    const tx = ty * (this.viewW / this.viewH);
    const nx = (px * r.x + py * r.y + pz * r.z) / depth / tx;
    const ny = (px * u.x + py * u.y + pz * u.z) / depth / ty;
    return { sx: (nx + 1) * 0.5 * this.viewW, sy: (1 - ny) * 0.5 * this.viewH };
  }

  /** Intersection of the screen ray with the horizontal plane at height z (in front of the eye), or null. */
  planeHit(sx: number, sy: number, z: number): Vec3 | null {
    const { o, d } = this.screenRay(sx, sy);
    if (Math.abs(d.z) < 1e-12) return null;
    const t = (z - o.z) / d.z;
    if (!(t > 0)) return null;
    return { x: o.x + d.x * t, y: o.y + d.y * t, z };
  }

  /** Ground point under a screen pixel (terrain raycast; falls back to the plane z = target.z). */
  pick(sx: number, sy: number): Vec3 | null {
    const { o, d } = this.screenRay(sx, sy);
    return this.ground.raycast(o, d) ?? this.planeHit(sx, sy, this.target.z);
  }

  metresPerPixel(): number {
    return (2 * this.distance * Math.tan(this.fovY / 2)) / this.viewH;
  }

  /** Distance at which the whole world fits the view at pitch 0 (with a 10% margin). */
  fitDistance(): number {
    const t = Math.tan(this.fovY / 2) * Math.min(1, this.viewW / this.viewH);
    return ((this.ground.size / 2) / t) * FIT_MARGIN;
  }

  /** Closest zoom in metres per pixel at the target (raise detail before lowering this). */
  minMetresPerPixel = 8;

  minDistance(): number {
    const fromPixels = (this.minMetresPerPixel * Math.max(1, this.viewH)) / (2 * Math.tan(this.fovY / 2));
    return Math.max(MIN_DISTANCE, fromPixels);
  }

  maxDistance(): number {
    return this.fitDistance() * MAX_DIST_OVER_FIT;
  }

  // ---- Interaction ------------------------------------------------------------------------------

  /** Eased zoom by `factor` (< 1 zooms in) keeping the ground point under (sx, sy) fixed on screen. */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.flight = null;
    this.zoomAnchor = this.pick(sx, sy);
    const lo = Math.log(this.minDistance() / this.distance);
    const hi = Math.log(this.maxDistance() / this.distance);
    this.zoomPending = Math.min(hi, Math.max(lo, this.zoomPending + Math.log(factor)));
  }

  /** Immediate zoom (pinch: tracks the fingers) keeping the ground point under (sx, sy) fixed. */
  pinchAt(sx: number, sy: number, factor: number): void {
    this.flight = null;
    this.zoomPending = 0;
    this.zoomAbout(this.pick(sx, sy), factor);
    this.settle();
  }

  /**
   * Grab pan by a screen delta: the ground under (sx − dx, sy − dy) moves to (sx, sy). The reference point
   * defaults to the screen centre; touch passes the finger centroid.
   */
  panScreen(dx: number, dy: number, sx = this.viewW / 2, sy = this.viewH / 2): void {
    this.flight = null;
    const g = this.pick(sx - dx, sy - dy);
    if (g) this.anchorAt(g, sx, sy);
    this.settle();
  }

  /** Moves the camera horizontally so that world point `p` appears under (sx, sy) (mouse grab pan). */
  dragTo(p: Vec3, sx: number, sy: number): void {
    this.flight = null;
    this.anchorAt(p, sx, sy);
    this.settle();
  }

  /** Pans by metres along the screen axes on the ground: `right` towards screen right, `forward` towards screen up. */
  panBy(right: number, forward: number): void {
    this.flight = null;
    const sb = Math.sin(this.bearing), cb = Math.cos(this.bearing);
    this.target.x += cb * right + sb * forward;
    this.target.y += -sb * right + cb * forward;
    this.settle();
  }

  /** Rotates about the target (screen centre). Any explicit tilt turns auto-tilt off. */
  rotateBy(dBearing: number, dPitch: number): void {
    this.flight = null;
    this.bearingGoal = null;
    this.bearing = wrapAngle(this.bearing + dBearing);
    if (dPitch !== 0) {
      this.autoTilt = false;
      this.pitch = this.clampPitch(this.pitch + dPitch);
    }
    this.settle();
  }

  /** Rotates the bearing about the ground point under (sx, sy) (two-finger / Safari rotate). */
  rotateAt(sx: number, sy: number, dBearing: number): void {
    this.flight = null;
    this.bearingGoal = null;
    const a = this.pick(sx, sy);
    this.bearing = wrapAngle(this.bearing + dBearing);
    if (a) this.anchorAt(a, sx, sy);
    this.settle();
  }

  /** Eases the bearing back to north up. */
  resetNorth(): void {
    this.bearingGoal = 0;
  }

  /** Whole world in view, north up, pitch 0; re-enables auto-tilt and cancels any animation. */
  fitWorld(): void {
    const s = this.ground.size;
    this.flight = null;
    this.zoomPending = 0;
    this.bearingGoal = null;
    this.autoTilt = true;
    this.target.x = s / 2;
    this.target.y = s / 2;
    this.target.z = this.groundAt(s / 2, s / 2);
    this.bearing = 0;
    this.pitch = 0;
    this.distance = this.fitDistance();
  }

  /** Smooth flight (van Wijk & Nuij: zooms out, travels, zooms in) to ground point (x, y) at `distance`. */
  flyTo(x: number, y: number, distance = this.distance): void {
    this.zoomPending = 0;
    const d1 = Math.min(this.maxDistance(), Math.max(this.minDistance(), distance));
    const kw = 2 * Math.tan(this.fovY / 2) * Math.max(1, this.viewW / this.viewH);
    const w0 = this.distance * kw, w1 = d1 * kw;
    const ex = x - this.target.x, ey = y - this.target.y;
    const u1 = Math.hypot(ex, ey);
    const rho2 = FLIGHT_RHO * FLIGHT_RHO;
    let r0 = 0, S: number;
    if (u1 < 1e-6 * Math.max(w0, w1)) {
      S = Math.abs(Math.log(w1 / w0)) / FLIGHT_RHO;
    } else {
      const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * u1 * u1) / (2 * w0 * rho2 * u1);
      const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * u1 * u1) / (2 * w1 * rho2 * u1);
      r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
      S = (Math.log(Math.sqrt(b1 * b1 + 1) - b1) - r0) / FLIGHT_RHO;
    }
    if (!(S > 1e-6)) {
      this.flight = null;
      return;
    }
    this.flight = {
      x0: this.target.x, y0: this.target.y, dx: u1 > 0 ? ex / u1 : 0, dy: u1 > 0 ? ey / u1 : 0, u1,
      w0, w1, r0, S, kw, d1, x1: x, y1: y,
      T: Math.min(2.2, Math.max(0.4, 0.45 * S)), t: 0,
    };
  }

  /** Per-frame: flight, eased zoom, eased north-up, then re-seat the target on the ground and clamp. */
  update(dtSec: number): void {
    if (this.flight) this.stepFlight(dtSec);

    if (this.zoomPending !== 0) {
      const k = 1 - Math.exp(-ZOOM_EASE * dtSec);
      let step = this.zoomPending * k;
      if (Math.abs(this.zoomPending - step) < 1e-4) step = this.zoomPending;
      this.zoomPending -= step;
      const before = this.distance;
      this.zoomAbout(this.zoomAnchor, Math.exp(step));
      if (this.distance === before) this.zoomPending = 0; // hit a distance limit
      if (this.zoomPending === 0) this.zoomAnchor = null;
    }

    if (this.bearingGoal !== null) {
      const diff = wrapAngle(this.bearingGoal - this.bearing);
      if (Math.abs(diff) < 1e-4) {
        this.bearing = this.bearingGoal;
        this.bearingGoal = null;
      } else {
        this.bearing = wrapAngle(this.bearing + diff * (1 - Math.exp(-BEARING_EASE * dtSec)));
      }
    }

    this.reseat();
    this.settle();
  }

  // ---- Internals --------------------------------------------------------------------------------

  private stepFlight(dtSec: number): void {
    const fl = this.flight!;
    fl.t = Math.min(fl.T, fl.t + dtSec);
    const a = fl.t / fl.T;
    const s = (a < 0.5 ? 4 * a * a * a : 1 - Math.pow(-2 * a + 2, 3) / 2) * fl.S;
    let u: number, w: number;
    if (fl.u1 < 1e-6 * Math.max(fl.w0, fl.w1)) {
      u = 0;
      w = fl.w0 * Math.exp(Math.sign(fl.w1 - fl.w0) * FLIGHT_RHO * s);
    } else {
      const rho2 = FLIGHT_RHO * FLIGHT_RHO;
      u = (fl.w0 / rho2) * (Math.cosh(fl.r0) * Math.tanh(FLIGHT_RHO * s + fl.r0) - Math.sinh(fl.r0));
      w = (fl.w0 * Math.cosh(fl.r0)) / Math.cosh(FLIGHT_RHO * s + fl.r0);
    }
    const done = fl.t >= fl.T;
    this.target.x = done ? fl.x1 : fl.x0 + fl.dx * u;
    this.target.y = done ? fl.y1 : fl.y0 + fl.dy * u;
    this.setDistance(done ? fl.d1 : w / fl.kw);
    if (done) this.flight = null;
  }

  /** Changes the distance about the target; with auto-tilt, pitch follows and a manual offset decays. */
  private setDistance(d: number): void {
    const d0 = this.distance;
    this.distance = Math.min(this.maxDistance(), Math.max(this.minDistance(), d));
    if (this.autoTilt) {
      const offset = this.pitch - autoPitch(d0);
      const decay = Math.exp(-AUTO_TILT_DECAY * Math.abs(Math.log(this.distance / d0)));
      this.pitch = autoPitch(this.distance) + offset * decay;
    }
    this.pitch = this.clampPitch(this.pitch);
  }

  /** Zoom by `factor` keeping `a` (if any) at its current screen position. */
  private zoomAbout(a: Vec3 | null, factor: number): void {
    const px = a ? this.project(a) : null;
    this.setDistance(this.distance * factor);
    if (a && px) this.anchorAt(a, px.sx, px.sy);
  }

  /** Horizontal camera translation that puts `p` under (sx, sy) (exact: intersects the plane z = p.z). */
  private anchorAt(p: Vec3, sx: number, sy: number): void {
    const h = this.planeHit(sx, sy, p.z);
    if (!h) return;
    this.target.x += p.x - h.x;
    this.target.y += p.y - h.y;
  }

  /** Moves the target along the view ray onto the terrain; the eye (and so the image) stays put. */
  private reseat(): void {
    const e = this.eye();
    const { f } = this.basis();
    const hit = this.ground.raycast(e, f);
    if (!hit || !Number.isFinite(hit.x + hit.y + hit.z)) return;
    const d = Math.hypot(hit.x - e.x, hit.y - e.y, hit.z - e.z);
    if (!(d > 1e-3)) return;
    this.target.x = hit.x;
    this.target.y = hit.y;
    this.target.z = hit.z;
    this.distance = d;
  }

  /** Clamps distance, pitch and target, then lifts the eye (by backing off along the view) above the ground. */
  private settle(): void {
    this.distance = Math.min(this.maxDistance(), Math.max(this.minDistance(), this.distance));
    this.pitch = this.clampPitch(this.pitch);
    const s = this.ground.size;
    const m = TARGET_MARGIN * this.metresPerPixel() * this.viewW;
    this.target.x = Math.min(s + m, Math.max(-m, this.target.x));
    this.target.y = Math.min(s + m, Math.max(-m, this.target.y));
    const cp = Math.cos(this.pitch);
    for (let i = 0; i < 6; i++) {
      const e = this.eye();
      const need = this.groundAt(e.x, e.y) + MIN_CLEARANCE - e.z;
      if (need <= 1e-6) break;
      this.distance += need / cp + 0.01;
    }
  }

  /** [0, MAX_PITCH], further limited so the top screen edge does not see more than 2 world sizes past the target. */
  private clampPitch(p: number): number {
    const limit = MAX_REACH_WORLDS * this.ground.size;
    const half = this.fovY / 2;
    const reach = (q: number): number =>
      q + half >= Math.PI / 2 - 1e-6
        ? Infinity
        : this.distance * (Math.cos(q) * Math.tan(q + half) - Math.sin(q));
    let hi = MAX_PITCH;
    if (reach(hi) > limit) {
      let lo = 0;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (reach(mid) > limit) hi = mid;
        else lo = mid;
      }
      hi = lo;
    }
    return Math.min(hi, Math.max(0, p));
  }

  private groundAt(x: number, y: number): number {
    const s = this.ground.size;
    return this.ground.heightAt(Math.min(s, Math.max(0, x)), Math.min(s, Math.max(0, y)));
  }
}

/** Wraps an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const t = 2 * Math.PI;
  a %= t;
  if (a > Math.PI) a -= t;
  else if (a <= -Math.PI) a += t;
  return a;
}
