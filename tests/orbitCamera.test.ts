import { describe, expect, it } from 'vitest';
import type { GroundQuery, Vec3 } from '../src/render/camera/ground';
import { OrbitCamera, autoPitch, MAX_PITCH } from '../src/render/camera/orbitCamera';
import { invert, mat4, mul, perspective, perspectiveReversedInfinite, transform4 } from '../src/render/math/mat4';

const SIZE = 1_000_000;
const W = 800;
const H = 600;
const DEG = Math.PI / 180;

function flatGround(z = 0): GroundQuery {
  return {
    size: SIZE,
    heightAt: () => z,
    raycast(o, d) {
      if (d.z >= 0) return null;
      const t = (z - o.z) / d.z;
      return t >= 0 ? { x: o.x + d.x * t, y: o.y + d.y * t, z } : null;
    },
  };
}

/** Gaussian hill (5 km high, σ = 40 km) at the world centre; raycast by marching + bisection. */
function hillGround(): GroundQuery {
  const HH = 5000, S2 = 40_000 ** 2, C = SIZE / 2;
  const heightAt = (x: number, y: number): number => HH * Math.exp(-((x - C) ** 2 + (y - C) ** 2) / S2);
  return {
    size: SIZE,
    heightAt,
    raycast(o, d) {
      if (d.z >= 0) return null;
      const f = (t: number): number => o.z + d.z * t - heightAt(o.x + d.x * t, o.y + d.y * t);
      const t0 = Math.max(0, (HH - o.z) / d.z);
      const t1 = -o.z / d.z;
      const N = 4000;
      let a = t0;
      for (let i = 1; i <= N; i++) {
        const b = t0 + ((t1 - t0) * i) / N;
        if (f(b) <= 0) return bisect(f, a, b, o, d);
        a = b;
      }
      return null;
    },
  };
}

function bisect(f: (t: number) => number, a: number, b: number, o: Vec3, d: Vec3): Vec3 {
  for (let k = 0; k < 100; k++) {
    const m = (a + b) / 2;
    if (f(m) > 0) a = m;
    else b = m;
  }
  const t = (a + b) / 2;
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}

function makeCam(g: GroundQuery, opts: { pitch?: number; bearing?: number; distance?: number; auto?: boolean } = {}): OrbitCamera {
  const cam = new OrbitCamera(g);
  cam.viewW = W;
  cam.viewH = H;
  cam.fitWorld();
  cam.target.x = SIZE / 2 - 30_000;
  cam.target.y = SIZE / 2 + 20_000;
  cam.target.z = g.heightAt(cam.target.x, cam.target.y);
  cam.distance = opts.distance ?? 60_000;
  cam.pitch = opts.pitch ?? 0;
  cam.bearing = opts.bearing ?? 0;
  cam.autoTilt = opts.auto ?? false;
  cam.update(0);
  return cam;
}

function screenDist(cam: OrbitCamera, p: Vec3, sx: number, sy: number): number {
  const s = cam.project(p);
  expect(s).not.toBeNull();
  return Math.hypot(s!.sx - sx, s!.sy - sy);
}

function run(cam: OrbitCamera, frames: number): void {
  for (let i = 0; i < frames; i++) cam.update(1 / 60);
}

const CURSORS: [number, number][] = [[100, 100], [700, 520], [400, 300], [60, 560], [620, 80]];
const POSES = [
  { pitch: 0, bearing: 0 },
  { pitch: 30 * DEG, bearing: 1.0 },
  { pitch: 55 * DEG, bearing: -2.5 },
];

describe('zoom to cursor', () => {
  for (const [name, ground] of [['flat', flatGround()], ['hill', hillGround()]] as const) {
    for (const pose of POSES) {
      for (const auto of [false, true]) {
        it(`${name}, pitch ${(pose.pitch / DEG).toFixed(0)}°, bearing ${pose.bearing}, autoTilt ${auto}: eased wheel zoom`, () => {
          for (const [sx, sy] of CURSORS) {
            for (const factor of [0.3, 2.5]) {
              const cam = makeCam(ground, { ...pose, auto });
              const a = cam.pick(sx, sy)!;
              expect(a).not.toBeNull();
              const d0 = cam.distance;
              cam.zoomAt(sx, sy, factor);
              run(cam, 90);
              expect(Math.abs(Math.log(cam.distance / d0))).toBeGreaterThan(0.5);
              expect(cam.moving).toBe(false);
              expect(screenDist(cam, a, sx, sy)).toBeLessThan(0.5);
            }
          }
        });
      }
      it(`${name}, pitch ${(pose.pitch / DEG).toFixed(0)}°: pinch keeps the point and actually zooms`, () => {
        for (const [sx, sy] of CURSORS) {
          const cam = makeCam(ground, pose);
          const a = cam.pick(sx, sy)!;
          const d0 = cam.distance;
          for (let i = 0; i < 10; i++) cam.pinchAt(sx, sy, 0.85);
          cam.update(1 / 60);
          expect(cam.distance).toBeLessThan(d0 * 0.5);
          expect(screenDist(cam, a, sx, sy)).toBeLessThan(0.5);
        }
      });
    }
  }

  it('rotateAt keeps the point under the cursor', () => {
    const cam = makeCam(hillGround(), { pitch: 40 * DEG, bearing: 0.3 });
    const a = cam.pick(250, 380)!;
    cam.rotateAt(250, 380, 0.7);
    cam.update(1 / 60);
    expect(screenDist(cam, a, 250, 380)).toBeLessThan(0.5);
  });
});

describe('pan', () => {
  it('grab pan moves the grabbed point with the pointer', () => {
    for (const ground of [flatGround(), hillGround()]) {
      for (const pose of POSES) {
        const cam = makeCam(ground, pose);
        const g = cam.pick(300, 200)!;
        for (const [x, y] of [[320, 230], [380, 260], [250, 150]] as const) {
          cam.dragTo(g, x, y);
          cam.update(1 / 60);
          expect(screenDist(cam, g, x, y)).toBeLessThan(0.5);
        }
      }
    }
  });

  it('panScreen moves the ground under the reference point by the delta', () => {
    for (const pose of POSES) {
      const cam = makeCam(flatGround(), pose);
      const g = cam.pick(450 - 25, 330 - 40)!;
      cam.panScreen(25, 40, 450, 330);
      expect(screenDist(cam, g, 450, 330)).toBeLessThan(0.5);
    }
  });

  it('panBy follows the bearing (bearing π/2: screen up is east)', () => {
    const cam = makeCam(flatGround(), { bearing: Math.PI / 2 });
    const x0 = cam.target.x, y0 = cam.target.y;
    cam.panBy(0, 1000);
    expect(cam.target.x - x0).toBeCloseTo(1000, 6);
    expect(cam.target.y - y0).toBeCloseTo(0, 6);
  });
});

describe('clamps', () => {
  it('never goes below the ground, even zooming into a hill at high tilt', () => {
    const g = hillGround();
    for (const pitch of [0, 45 * DEG, MAX_PITCH]) {
      const cam = makeCam(g, { pitch, distance: 20_000 });
      cam.target.x = SIZE / 2 + 3000;
      cam.target.y = SIZE / 2;
      for (let i = 0; i < 40; i++) {
        cam.zoomAt(400, 300, 0.5);
        run(cam, 5);
        cam.panBy(0, 800);
        run(cam, 2);
        const e = cam.eye();
        expect(e.z).toBeGreaterThanOrEqual(g.heightAt(e.x, e.y) + 29.9);
        expect(cam.distance).toBeGreaterThanOrEqual(cam.minDistance() - 1e-9);
      }
    }
  });

  it('keeps the target inside the world with a margin and the distance below max', () => {
    const cam = makeCam(flatGround(), { bearing: 0.4 });
    cam.panBy(1e9, -1e9);
    cam.update(1 / 60);
    const m = 0.1 * cam.metresPerPixel() * cam.viewW + 1e-6;
    expect(cam.target.x).toBeLessThanOrEqual(SIZE + m);
    expect(cam.target.x).toBeGreaterThanOrEqual(-m);
    expect(cam.target.y).toBeLessThanOrEqual(SIZE + m);
    expect(cam.target.y).toBeGreaterThanOrEqual(-m);
    cam.zoomAt(400, 300, 1e6);
    run(cam, 120);
    expect(cam.distance).toBeLessThanOrEqual(cam.maxDistance() + 1e-6);
  });

  it('limits the pitch to [0, 60°]', () => {
    const cam = makeCam(flatGround());
    cam.rotateBy(0, 10);
    expect(cam.pitch).toBeLessThanOrEqual(MAX_PITCH);
    expect(cam.autoTilt).toBe(false);
    cam.rotateBy(0, -10);
    expect(cam.pitch).toBe(0);
  });
});

describe('projection', () => {
  it('viewProjRelative maps the target to the screen centre for any origin', () => {
    const vp = new Float32Array(16);
    const v = new Float64Array(4);
    for (const reversed of [false, true]) {
      for (const pose of POSES) {
        const cam = makeCam(hillGround(), pose);
        cam.reversedZ = reversed;
        for (const origin of [cam.eye(), { x: SIZE / 2, y: SIZE / 2, z: 0 }]) {
          cam.viewProjRelative(vp, origin);
          const t = cam.target;
          transform4(v, vp, t.x - origin.x, t.y - origin.y, t.z - origin.z);
          expect(Math.abs(v[0] / v[3])).toBeLessThan(1e-4);
          expect(Math.abs(v[1] / v[3])).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('viewProjRelative agrees with project() off-centre', () => {
    const cam = makeCam(flatGround(), POSES[1]);
    const vp = new Float32Array(16);
    const v = new Float64Array(4);
    const o = cam.eye();
    cam.viewProjRelative(vp, o);
    const p = cam.pick(130, 470)!;
    transform4(v, vp, p.x - o.x, p.y - o.y, p.z - o.z);
    expect(((v[0] / v[3] + 1) / 2) * W).toBeCloseTo(130, 1);
    expect(((1 - v[1] / v[3]) / 2) * H).toBeCloseTo(470, 1);
  });

  it('screenRay / pick / project round-trip', () => {
    for (const pose of POSES) {
      const cam = makeCam(hillGround(), pose);
      const c = cam.screenRay(W / 2, H / 2);
      const e = cam.eye();
      const toT = { x: cam.target.x - e.x, y: cam.target.y - e.y, z: cam.target.z - e.z };
      const l = Math.hypot(toT.x, toT.y, toT.z);
      expect(c.d.x * toT.x / l + c.d.y * toT.y / l + c.d.z * toT.z / l).toBeCloseTo(1, 9);
      for (const [sx, sy] of CURSORS) {
        const p = cam.pick(sx, sy)!;
        expect(screenDist(cam, p, sx, sy)).toBeLessThan(1e-3);
      }
    }
  });

  it('bearing convention: at bearing π/2 east is up on screen', () => {
    const cam = makeCam(flatGround(), { bearing: Math.PI / 2 });
    const east = cam.project({ x: cam.target.x + 5000, y: cam.target.y, z: 0 })!;
    expect(east.sx).toBeCloseTo(W / 2, 6);
    expect(east.sy).toBeLessThan(H / 2);
  });

  it('frustum planes contain the target and reject a point behind the eye', () => {
    for (const reversed of [false, true]) {
      const cam = makeCam(hillGround(), POSES[2]);
      cam.reversedZ = reversed;
      const o = cam.eye();
      const pl = cam.frustumPlanesRelative(new Float64Array(24), o);
      const inside = (p: Vec3): boolean => {
        for (let i = 0; i < 6; i++) {
          const v = pl[i * 4] * (p.x - o.x) + pl[i * 4 + 1] * (p.y - o.y) + pl[i * 4 + 2] * (p.z - o.z) + pl[i * 4 + 3];
          if (!(v >= -1e-6)) return false;
        }
        return true;
      };
      expect(inside(cam.target)).toBe(true);
      expect(inside(cam.pick(5, 5)!)).toBe(true);
      expect(inside({ x: o.x, y: o.y, z: o.z + 100 })).toBe(false);
      expect(Number.isFinite(pl[23])).toBe(!reversed);
    }
  });
});

describe('fitWorld', () => {
  it('shows all four corners, north up, pitch 0', () => {
    for (const [w, h] of [[800, 600], [600, 900], [1920, 400]]) {
      const cam = new OrbitCamera(hillGround());
      cam.viewW = w;
      cam.viewH = h;
      cam.rotateBy(1, 0.5);
      cam.fitWorld();
      cam.update(1 / 60);
      expect(cam.pitch).toBe(0);
      expect(cam.bearing).toBe(0);
      for (const [x, y] of [[0, 0], [SIZE, 0], [0, SIZE], [SIZE, SIZE]]) {
        const s = cam.project({ x, y, z: 0 })!;
        expect(s.sx).toBeGreaterThan(0);
        expect(s.sx).toBeLessThan(w);
        expect(s.sy).toBeGreaterThan(0);
        expect(s.sy).toBeLessThan(h);
      }
      const north = cam.project({ x: SIZE / 2, y: SIZE, z: 0 })!;
      expect(north.sy).toBeLessThan(h / 2);
    }
  });
});

describe('depth', () => {
  it('standard projection maps near → −1 and far → +1', () => {
    const p = perspective(mat4(), 0.6, 1.5, 10, 5000);
    const v = new Float64Array(4);
    transform4(v, p, 0, 0, -10);
    expect(v[2] / v[3]).toBeCloseTo(-1, 9);
    transform4(v, p, 0, 0, -5000);
    expect(v[2] / v[3]).toBeCloseTo(1, 9);
  });

  it('reversed-Z infinite maps near → 1 and infinity → 0', () => {
    const p = perspectiveReversedInfinite(mat4(), 0.6, 1.5, 10);
    const v = new Float64Array(4);
    transform4(v, p, 0, 0, -10);
    expect(v[2] / v[3]).toBeCloseTo(1, 12);
    transform4(v, p, 0, 0, -1e12);
    expect(v[2] / v[3]).toBeCloseTo(0, 9);
  });

  it('the camera near plane lands on the right depth in both modes', () => {
    const vp = new Float32Array(16);
    const v = new Float64Array(4);
    for (const reversed of [false, true]) {
      const cam = makeCam(flatGround(), POSES[1]);
      cam.reversedZ = reversed;
      const o = cam.eye();
      cam.viewProjRelative(vp, o);
      const { d } = cam.screenRay(W / 2, H / 2);
      const n = cam.near();
      transform4(v, vp, d.x * n, d.y * n, d.z * n);
      expect(v[2] / v[3]).toBeCloseTo(reversed ? 1 : -1, 4);
      expect(cam.far()).toBe(reversed ? Infinity : cam.far());
      if (!reversed) expect(cam.far() / cam.near()).toBeLessThanOrEqual(1e5 + 1e-6);
    }
  });

  it('mat4 invert/mul round-trip', () => {
    const p = perspective(mat4(), 0.6, 1.5, 10, 5000);
    const inv = invert(mat4(), p)!;
    const id = mul(mat4(), p, inv);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9);
  });
});

describe('auto-tilt and flight', () => {
  it('autoPitch is 0 high up and ~42° near the ground', () => {
    expect(autoPitch(500_000)).toBe(0);
    expect(autoPitch(200_000)).toBe(0);
    expect(autoPitch(3000) / DEG).toBeCloseTo(42, 6);
    expect(autoPitch(30_000)).toBeGreaterThan(0);
  });

  it('flyTo arrives at the destination and distance', () => {
    const cam = makeCam(flatGround(), { auto: true });
    cam.flyTo(100_000, 900_000, 20_000);
    let maxD = 0;
    for (let i = 0; i < 400 && cam.moving; i++) {
      cam.update(1 / 60);
      maxD = Math.max(maxD, cam.distance);
    }
    expect(cam.moving).toBe(false);
    expect(cam.target.x).toBeCloseTo(100_000, 3);
    expect(cam.target.y).toBeCloseTo(900_000, 3);
    expect(cam.distance).toBeCloseTo(20_000, 3);
    expect(maxD).toBeGreaterThan(60_000); // zoomed out on the way
  });

  it('resetNorth eases the bearing back to 0', () => {
    const cam = makeCam(flatGround(), { bearing: 2 });
    cam.resetNorth();
    run(cam, 120);
    expect(cam.bearing).toBe(0);
  });
});
