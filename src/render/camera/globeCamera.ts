import type { Vec3 } from './ground';
import type { ViewCamera } from './viewCamera';
import type { GlobeGround } from '../globe/globeGround';
import { raySphere } from '../globe/globeGround';
import { autoPitch, MAX_PITCH, wrapAngle } from './orbitCamera';
import { lookAt, mul, perspective, perspectiveReversedInfinite } from '../math/mat4';

const DEG = Math.PI / 180;
const MIN_DISTANCE = 100;      // m, eye → target
const MIN_CLEARANCE = 30;      // m, eye above the ground below it
const FIT_MARGIN = 1.1;        // whole planet in view with a 10 % margin
const MAX_DIST_OVER_FIT = 1.15 / FIT_MARGIN;
const ZOOM_EASE = 18;          // 1/s, as the flat camera
const BEARING_EASE = 10;       // 1/s
const FLIGHT_RHO = 1.42;
/** Inside this latitude the frame is parallel-transported instead of kept north-up (no spin at the poles). */
const POLAR_CAP = Math.sin(85 * DEG);
/** The view may look at most this far above the horizon. */
const ABOVE_HORIZON = 10 * DEG;

interface Basis {
  r: Vec3;
  u: Vec3;
  f: Vec3;
}

interface Flight {
  axis: Vec3;
  angle: number; // total great-circle angle (rad)
  done: number;  // angle travelled so far
  u1: number;    // travel length (m)
  w0: number;
  w1: number;
  r0: number;
  S: number;
  kw: number;
  d1: number;
  T: number;
  t: number;
}

/**
 * Globe orbit camera for sphere worlds (research 10 §6.4). The state is float64: the target as a unit
 * vector plus its rendered height, the eye → target distance, pitch and bearing in the target's local
 * east / north / up frame. Near the surface this is exactly the flat `OrbitCamera` in the tangent
 * plane; far out the same camera frames the whole planet, so there is no mode switch.
 *
 * - Pan is a rotation about the planet centre: grab pan keeps the grabbed point under the cursor by
 *   intersecting the cursor ray with the sphere through that point (iterated, so the north-up
 *   re-alignment does not let it drift); trackpad and key pans rotate by metres / radius.
 * - Zoom to cursor changes the distance about the target, then grab-pans the anchor back under the cursor.
 * - Bearing is relative to local north while |latitude| < 85°; inside the polar caps the frame is
 *   parallel-transported, so the view does not spin over a pole.
 *
 * World space: planet-centred metres, +z north (globe/globeGround.ts).
 */
export class GlobeCamera implements ViewCamera {
  /** Unit vector of the target (the ground point the camera orbits). */
  readonly dir: Vec3 = { x: 1, y: 0, z: 0 };
  /** Rendered height of the target above the sea-level radius (m, exaggerated). */
  targetH = 0;
  distance = 1e6;
  pitch = 0;
  fovY = 32 * DEG;
  viewW = 1;
  viewH = 1;
  reversedZ = false;
  autoTilt = true;
  /** Closest zoom: 2 km sphere cells have no close-zoom detail map yet (Phase 4). */
  minMetresPerPixel = 40;

  /** Local east of the frame (unit, ⟂ dir); true east outside the polar caps. */
  private readonly east: Vec3 = { x: 0, y: 1, z: 0 };
  /** Bearing relative to the frame's north. */
  private fb = 0;
  private inCap = false;
  private ground: GlobeGround;
  private zoomPending = 0;
  private zoomAnchor: Vec3 | null = null;
  private bearingGoal: number | null = null;
  private flight: Flight | null = null;

  constructor(ground: GlobeGround) {
    this.ground = ground;
    this.lookAtLatLon(15, 0);
    this.fitWorld();
  }

  get radius(): number {
    return this.ground.radius;
  }

  /** Swaps the terrain; refits when the planet radius changed, otherwise keeps the view. */
  setGround(g: GlobeGround): void {
    const resized = g.radius !== this.ground.radius;
    this.ground = g;
    if (resized) this.fitWorld();
    else {
      this.targetH = this.groundAtDir(this.dir);
      this.settle();
    }
  }

  get moving(): boolean {
    return this.flight !== null || this.zoomPending !== 0 || this.bearingGoal !== null;
  }

  /** Target point (planet-centred, m). */
  get target(): Vec3 {
    const r = this.ground.radius + this.targetH;
    return { x: this.dir.x * r, y: this.dir.y * r, z: this.dir.z * r };
  }

  /** Latitude and longitude of the target (degrees). */
  latLon(): [number, number] {
    const d = this.dir;
    return [Math.asin(Math.max(-1, Math.min(1, d.z))) / DEG, Math.atan2(d.y, d.x) / DEG];
  }

  /** Heading relative to true north (the compass); the frame bearing inside the polar caps' very centre. */
  get bearing(): number {
    if (!this.inCap) return this.fb;
    const tn = trueEast(this.dir);
    if (!tn) return this.fb;
    const { e, n } = this.frame();
    const sb = Math.sin(this.fb), cb = Math.cos(this.fb);
    const fh = add(scale(e, sb), scale(n, cb));
    const tnN = cross(this.dir, tn);
    return Math.atan2(dot(fh, tn), dot(fh, tnN));
  }

  /** Points the camera at a latitude / longitude (degrees), north up. */
  lookAtLatLon(lat: number, lon: number): void {
    const la = lat * DEG, lo = lon * DEG;
    this.setFrame({ x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) }, null);
    this.fb = 0;
    this.targetH = this.groundAtDir(this.dir);
  }

  /** East / north / up of the target frame. */
  frame(): { e: Vec3; n: Vec3; u: Vec3 } {
    return { e: this.east, n: cross(this.dir, this.east), u: this.dir };
  }

  /** Screen right, screen up and view direction, plus the horizontal forward direction at the target. */
  axes(): Basis & { fh: Vec3 } {
    const b = this.basis();
    const { e, n } = this.frame();
    return { ...b, fh: add(scale(e, Math.sin(this.fb)), scale(n, Math.cos(this.fb))) };
  }

  private basis(): Basis {
    const { e, n, u: up } = this.frame();
    const sb = Math.sin(this.fb), cb = Math.cos(this.fb);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    return {
      r: add(scale(e, cb), scale(n, -sb)),
      u: add3(scale(e, sb * cp), scale(n, cb * cp), scale(up, sp)),
      f: add3(scale(e, sb * sp), scale(n, cb * sp), scale(up, -cp)),
    };
  }

  eye(): Vec3 {
    const t = this.target;
    const { f } = this.basis();
    return { x: t.x - f.x * this.distance, y: t.y - f.y * this.distance, z: t.z - f.z * this.distance };
  }

  /** Eye altitude above the rendered ground below it (≥ 1 m). */
  clearance(): number {
    const e = this.eye();
    const r = Math.hypot(e.x, e.y, e.z);
    return Math.max(1, r - this.ground.radius - this.ground.heightAtDir(e.x, e.y, e.z));
  }

  /** Eye altitude above sea level (m). */
  altitude(): number {
    const e = this.eye();
    return Math.hypot(e.x, e.y, e.z) - this.ground.radius;
  }

  // ---- Projection -------------------------------------------------------------------------------

  near(): number {
    const c = this.clearance();
    if (this.reversedZ) return Math.max(1, Math.min(0.0005 * c, 0.5 * c));
    const near = Math.min(50_000, Math.max(1, 0.3 * c));
    return Math.max(near, this.farStandard() / 1e5);
  }

  far(): number {
    return this.reversedZ ? Infinity : this.farStandard();
  }

  /** Distance to the horizon of the sea-level sphere plus the reach of the highest ground beyond it. */
  private farStandard(): number {
    const e = this.eye();
    const R = this.ground.radius;
    const top = R + this.ground.maxHeight + 1000;
    const er = Math.hypot(e.x, e.y, e.z);
    return 1.05 * (Math.sqrt(Math.max(0, er * er - R * R)) + Math.sqrt(top * top - R * R)) + 1000;
  }

  viewProjRelative(out: Float32Array, origin: Vec3): Float32Array {
    const e = this.eye();
    const { u, f } = this.basis();
    const rel = { x: e.x - origin.x, y: e.y - origin.y, z: e.z - origin.z };
    const view = lookAt(new Float64Array(16), rel, { x: rel.x + f.x, y: rel.y + f.y, z: rel.z + f.z }, u);
    const aspect = this.viewW / this.viewH;
    const proj = new Float64Array(16);
    if (this.reversedZ) perspectiveReversedInfinite(proj, this.fovY, aspect, this.near());
    else perspective(proj, this.fovY, aspect, this.near(), this.far());
    out.set(mul(proj, proj, view));
    return out;
  }

  /** Frustum planes as in `OrbitCamera.frustumPlanesRelative` (inside where a·x + b·y + c·z + d ≥ 0). */
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

  screenRay(sx: number, sy: number): { o: Vec3; d: Vec3 } {
    const { r, u, f } = this.basis();
    const ty = Math.tan(this.fovY / 2);
    const nx = (2 * sx / this.viewW - 1) * ty * (this.viewW / this.viewH);
    const ny = (1 - 2 * sy / this.viewH) * ty;
    const d = add3(f, scale(r, nx), scale(u, ny));
    return { o: this.eye(), d: normalize(d) };
  }

  project(p: Vec3): { sx: number; sy: number } | null {
    const e = this.eye();
    const { r, u, f } = this.basis();
    const v = sub(p, e);
    const depth = dot(v, f);
    if (depth <= 1e-9) return null;
    const ty = Math.tan(this.fovY / 2);
    const tx = ty * (this.viewW / this.viewH);
    const nx = dot(v, r) / depth / tx;
    const ny = dot(v, u) / depth / ty;
    return { sx: (nx + 1) * 0.5 * this.viewW, sy: (1 - ny) * 0.5 * this.viewH };
  }

  /** Terrain point under a screen pixel, or null (the ray misses the planet). */
  pick(sx: number, sy: number): Vec3 | null {
    const { o, d } = this.screenRay(sx, sy);
    return this.ground.raycast(o, d);
  }

  /**
   * Where the screen ray meets the sphere |p| = r (the nearer hit), or — when it misses — the point of
   * that sphere closest to the ray (on the limb), so drags past the edge of the planet keep turning it.
   */
  sphereHit(sx: number, sy: number, r: number): Vec3 {
    const { o, d } = this.screenRay(sx, sy);
    const h = raySphere(o, d, r);
    if (h && h[1] >= 0) {
      const t = h[0] >= 0 ? h[0] : h[1];
      return add(o, scale(d, t));
    }
    const t = Math.max(0, -dot(o, d));
    return scale(normalize(add(o, scale(d, t))), r);
  }

  metresPerPixel(): number {
    return (2 * this.distance * Math.tan(this.fovY / 2)) / this.viewH;
  }

  /** Half-angle of the narrower view axis. */
  private halfFov(): number {
    return Math.atan(Math.tan(this.fovY / 2) * Math.min(1, this.viewW / this.viewH));
  }

  /** Eye → target distance at which the whole planet fits the narrower view axis (pitch 0, 10 % margin). */
  fitDistance(): number {
    const R = this.ground.radius;
    return (R / Math.sin(this.halfFov())) * FIT_MARGIN - R - this.targetH;
  }

  minDistance(): number {
    const fromPixels = (this.minMetresPerPixel * Math.max(1, this.viewH)) / (2 * Math.tan(this.fovY / 2));
    return Math.max(MIN_DISTANCE, fromPixels);
  }

  maxDistance(): number {
    const R = this.ground.radius;
    return (R / Math.sin(this.halfFov())) * FIT_MARGIN * MAX_DIST_OVER_FIT - R - this.targetH;
  }

  // ---- Interaction ------------------------------------------------------------------------------

  zoomAt(sx: number, sy: number, factor: number): void {
    this.flight = null;
    this.zoomAnchor = this.pick(sx, sy);
    const lo = Math.log(this.minDistance() / this.distance);
    const hi = Math.log(this.maxDistance() / this.distance);
    this.zoomPending = Math.min(hi, Math.max(lo, this.zoomPending + Math.log(factor)));
  }

  pinchAt(sx: number, sy: number, factor: number): void {
    this.flight = null;
    this.zoomPending = 0;
    this.zoomAbout(this.pick(sx, sy), factor);
    this.settle();
  }

  panScreen(dx: number, dy: number, sx = this.viewW / 2, sy = this.viewH / 2): void {
    this.flight = null;
    const g = this.pick(sx - dx, sy - dy);
    if (g) this.anchorAt(g, sx, sy);
    this.settle();
  }

  dragTo(p: Vec3, sx: number, sy: number): void {
    this.flight = null;
    this.anchorAt(p, sx, sy);
    this.settle();
  }

  /** Rotates the planet so the target moves by metres along the screen's right / up directions on the ground. */
  panBy(right: number, forward: number): void {
    this.flight = null;
    const { e, n } = this.frame();
    const sb = Math.sin(this.fb), cb = Math.cos(this.fb);
    const v = add(scale(add(scale(e, cb), scale(n, -sb)), right), scale(add(scale(e, sb), scale(n, cb)), forward));
    const len = Math.hypot(v.x, v.y, v.z);
    if (len > 0) this.rotateRig(normalize(cross(this.dir, v)), len / (this.ground.radius + this.targetH));
    this.settle();
  }

  rotateBy(dBearing: number, dPitch: number): void {
    this.flight = null;
    this.bearingGoal = null;
    this.fb = wrapAngle(this.fb + dBearing);
    if (dPitch !== 0) {
      this.autoTilt = false;
      this.pitch = this.clampPitch(this.pitch + dPitch);
    }
    this.settle();
  }

  rotateAt(sx: number, sy: number, dBearing: number): void {
    this.flight = null;
    this.bearingGoal = null;
    const a = this.pick(sx, sy);
    this.fb = wrapAngle(this.fb + dBearing);
    if (a) this.anchorAt(a, sx, sy);
    this.settle();
  }

  resetNorth(): void {
    this.bearingGoal = 0;
  }

  /** Whole planet in view around the current target, north up, pitch 0; re-enables auto-tilt. */
  fitWorld(): void {
    this.flight = null;
    this.zoomPending = 0;
    this.bearingGoal = null;
    this.autoTilt = true;
    this.fb = wrapAngle(this.fb - this.bearing);
    this.pitch = 0;
    this.targetH = this.groundAtDir(this.dir);
    this.distance = this.fitDistance();
  }

  /** Smooth flight along the great circle to a direction (van Wijk & Nuij: zooms out, travels, zooms in). */
  flyToDir(to: Vec3, distance = this.distance): void {
    this.zoomPending = 0;
    const d1 = Math.min(this.maxDistance(), Math.max(this.minDistance(), distance));
    const t1 = normalize(to);
    const kw = 2 * Math.tan(this.fovY / 2) * Math.max(1, this.viewW / this.viewH);
    const w0 = this.distance * kw, w1 = d1 * kw;
    const c = cross(this.dir, t1);
    const sinA = Math.hypot(c.x, c.y, c.z);
    const angle = Math.atan2(sinA, dot(this.dir, t1));
    const axis = sinA > 1e-12 ? scale(c, 1 / sinA) : this.frame().e;
    const u1 = angle * this.ground.radius;
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
    this.flight = { axis, angle, done: 0, u1, w0, w1, r0, S, kw, d1, T: Math.min(2.4, Math.max(0.4, 0.45 * S)), t: 0 };
  }

  /** Flies to a latitude / longitude (degrees). */
  flyToLatLon(lat: number, lon: number, distance = this.distance): void {
    const la = lat * DEG, lo = lon * DEG;
    this.flyToDir({ x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) }, distance);
  }

  update(dtSec: number): void {
    if (this.flight) this.stepFlight(dtSec);
    if (this.zoomPending !== 0) {
      const k = 1 - Math.exp(-ZOOM_EASE * dtSec);
      let step = this.zoomPending * k;
      if (Math.abs(this.zoomPending - step) < 1e-4) step = this.zoomPending;
      this.zoomPending -= step;
      const before = this.distance;
      this.zoomAbout(this.zoomAnchor, Math.exp(step));
      if (this.distance === before) this.zoomPending = 0;
      if (this.zoomPending === 0) this.zoomAnchor = null;
    }
    if (this.bearingGoal !== null) {
      const diff = wrapAngle(this.bearingGoal - this.bearing);
      if (Math.abs(diff) < 1e-4) {
        this.fb = wrapAngle(this.fb + diff);
        this.bearingGoal = null;
      } else {
        this.fb = wrapAngle(this.fb + diff * (1 - Math.exp(-BEARING_EASE * dtSec)));
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
    const goal = done ? fl.angle : fl.u1 > 0 ? (fl.angle * u) / fl.u1 : 0;
    this.rotateRig(fl.axis, goal - fl.done);
    fl.done = goal;
    this.targetH = this.groundAtDir(this.dir);
    this.setDistance(done ? fl.d1 : w / fl.kw);
    if (done) this.flight = null;
  }

  private setDistance(d: number): void {
    const d0 = this.distance;
    this.distance = Math.min(this.maxDistance(), Math.max(this.minDistance(), d));
    if (this.autoTilt) {
      const offset = this.pitch - autoPitch(d0);
      const decay = Math.exp(-3 * Math.abs(Math.log(this.distance / d0)));
      this.pitch = autoPitch(this.distance) + offset * decay;
    }
    this.pitch = this.clampPitch(this.pitch);
  }

  private zoomAbout(a: Vec3 | null, factor: number): void {
    const px = a ? this.project(a) : null;
    this.setDistance(this.distance * factor);
    if (a && px) this.anchorAt(a, px.sx, px.sy);
  }

  /**
   * Rotates the camera rig about the planet centre so that `p` is under (sx, sy). First guess: the
   * rotation that takes the cursor ray's hit on the sphere |x| = |p| to p (exact for a rigid rig).
   * The north-up re-alignment then turns the view a little about the target, so a few Newton steps
   * on the 2D rotation (numerical Jacobian of p's screen position) remove the remaining error.
   */
  private anchorAt(p: Vec3, sx: number, sy: number): void {
    const r = Math.hypot(p.x, p.y, p.z);
    if (!(r > 0)) return;
    const err = (): number => {
      const s0 = this.project(p);
      return s0 ? Math.hypot(s0.sx - sx, s0.sy - sy) : Infinity;
    };
    const start = this.saveRig();
    const e0 = err();
    const q = this.sphereHit(sx, sy, r);
    const c = cross(q, p);
    const s = Math.hypot(c.x, c.y, c.z) / (r * r);
    if (s > 1e-13) this.rotateRig(scale(c, 1 / (s * r * r)), Math.atan2(s, dot(q, p) / (r * r)));
    let best = err();
    if (!(best <= e0)) {
      this.restoreRig(start);
      best = e0;
    }
    const eps = Math.max(1e-9, (0.5 * this.metresPerPixel()) / this.ground.radius);
    for (let k = 0; k < 12 && best > 1e-5; k++) {
      const s0 = this.project(p);
      if (!s0) return;
      const ex = s0.sx - sx, ey = s0.sy - sy;
      const saved = this.saveRig();
      const { e: E, n: N } = this.frame();
      const axes = [{ ...E }, { ...N }];
      const J: number[] = [];
      for (const ax of axes) {
        this.rotateRig(ax, eps);
        const s1 = this.project(p);
        this.restoreRig(saved);
        if (!s1) return;
        J.push((s1.sx - s0.sx) / eps, (s1.sy - s0.sy) / eps);
      }
      // [J0 J2; J1 J3] · w = −(ex, ey)
      const det = J[0] * J[3] - J[2] * J[1];
      if (!(Math.abs(det) > 1e-12)) return;
      const w1 = (-ex * J[3] + ey * J[2]) / det;
      const w2 = (-ey * J[0] + ex * J[1]) / det;
      const axis = add(scale(axes[0], w1), scale(axes[1], w2));
      let ang = Math.hypot(axis.x, axis.y, axis.z);
      if (!(ang > 0)) return;
      // Damped step: halve until the error drops (the north-up constraint makes the map nonlinear far out).
      let improved = false;
      for (let h = 0; h < 6 && !improved; h++, ang *= 0.5) {
        this.rotateRig(normalize(axis), Math.min(ang, 0.3));
        const e1 = err();
        if (e1 < best) {
          best = e1;
          improved = true;
        } else this.restoreRig(saved);
      }
      if (!improved) return;
    }
  }

  private saveRig(): [Vec3, Vec3, number, boolean] {
    return [{ ...this.dir }, { ...this.east }, this.fb, this.inCap];
  }

  private restoreRig([d, e, fb, cap]: [Vec3, Vec3, number, boolean]): void {
    Object.assign(this.dir, d);
    Object.assign(this.east, e);
    this.fb = fb;
    this.inCap = cap;
  }

  /** Rotates target and frame about a unit axis through the centre, then re-aligns north. */
  private rotateRig(axis: Vec3, angle: number): void {
    if (angle === 0) return;
    this.setFrame(normalize(rotate(this.dir, axis, angle)), rotate(this.east, axis, angle));
  }

  /**
   * Moves the target to unit vector `nu`. `east` is the transported frame east (null: take true east).
   * Outside the polar caps the frame snaps to true north and the bearing stays the true bearing; inside
   * them the transported frame is kept; leaving a cap converts the bearing so the view does not jump.
   */
  private setFrame(nu: Vec3, east: Vec3 | null): void {
    const capped = Math.abs(nu.z) > POLAR_CAP;
    let et = east ? normalize(sub(east, scale(nu, dot(east, nu)))) : null;
    if (!capped || !et) {
      const te = trueEast(nu) ?? et ?? { x: 0, y: 1, z: 0 };
      if (this.inCap && et) {
        // Keep the forward direction: express it in the true frame.
        const sb = Math.sin(this.fb), cb = Math.cos(this.fb);
        const fh = add(scale(et, sb), scale(cross(nu, et), cb));
        this.fb = Math.atan2(dot(fh, te), dot(fh, cross(nu, te)));
      }
      et = te;
    }
    this.dir.x = nu.x;
    this.dir.y = nu.y;
    this.dir.z = nu.z;
    this.east.x = et.x;
    this.east.y = et.y;
    this.east.z = et.z;
    this.inCap = capped;
  }

  /**
   * Moves the target along the view ray onto the terrain, keeping the eye and view direction: the
   * pitch and bearing are re-derived in the new target's frame.
   */
  private reseat(): void {
    const e = this.eye();
    const b = this.basis();
    const hit = this.ground.raycast(e, b.f);
    if (!hit || !Number.isFinite(hit.x + hit.y + hit.z)) return;
    const d = Math.hypot(hit.x - e.x, hit.y - e.y, hit.z - e.z);
    if (!(d > 1e-3)) return;
    const t = this.target;
    // Skip sub-millimetre moves so a still camera reaches a fixed point (idle frames stay idle).
    if (Math.hypot(hit.x - t.x, hit.y - t.y, hit.z - t.z) < 1e-3 + 1e-9 * d) return;
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    // The horizontal forward direction, exact at every pitch.
    const fh = add(scale(b.f, sp), scale(b.u, cp));
    const r = Math.hypot(hit.x, hit.y, hit.z);
    const nu = scale(hit, 1 / r);
    this.setFrame(nu, this.east);
    const { e: E, n: N } = this.frame();
    this.pitch = Math.acos(Math.max(-1, Math.min(1, -dot(b.f, nu))));
    this.fb = Math.atan2(dot(fh, E), dot(fh, N));
    this.targetH = r - this.ground.radius;
    this.distance = d;
  }

  private settle(): void {
    this.distance = Math.min(this.maxDistance(), Math.max(this.minDistance(), this.distance));
    this.pitch = this.clampPitch(this.pitch);
    const cp = Math.cos(this.pitch);
    for (let i = 0; i < 6; i++) {
      const e = this.eye();
      const er = Math.hypot(e.x, e.y, e.z);
      const need = this.ground.radius + this.ground.heightAtDir(e.x, e.y, e.z) + MIN_CLEARANCE - er;
      if (need <= 1e-6) break;
      this.distance += need / Math.max(0.2, cp) + 0.01;
    }
  }

  /** [0, MAX_PITCH], and the top of the view at most 10° above the horizon of the eye. */
  private clampPitch(p: number): number {
    const R = this.ground.radius;
    const dip = Math.acos(Math.min(1, R / (R + this.targetH + this.distance)));
    const hi = Math.max(0, Math.min(MAX_PITCH, Math.PI / 2 + ABOVE_HORIZON - this.fovY / 2 - dip));
    return Math.min(hi, Math.max(0, p));
  }

  private groundAtDir(d: Vec3): number {
    return this.ground.heightAtDir(d.x, d.y, d.z);
  }
}

// ---- Vector helpers (float64) ----------------------------------------------------------------------

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function add3(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return { x: a.x + b.x + c.x, y: a.y + b.y + c.y, z: a.z + b.z + c.z };
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? scale(a, 1 / l) : { x: 0, y: 0, z: 1 };
}
/** Rodrigues rotation of v about a unit axis. */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return { x: v.x * c + kv.x * s + k.x * kd, y: v.y * c + kv.y * s + k.y * kd, z: v.z * c + kv.z * s + k.z * kd };
}
/** True local east (ẑ × up, normalised), or null at a pole. */
function trueEast(up: Vec3): Vec3 | null {
  const x = -up.y, y = up.x;
  const l = Math.hypot(x, y);
  return l < 1e-9 ? null : { x: x / l, y: y / l, z: 0 };
}
