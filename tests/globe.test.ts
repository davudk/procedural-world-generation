import { describe, expect, it } from 'vitest';
import { cubeGrid, padFace } from '../src/gen/grid/cube';
import { acrossCell, dirToFaceAngles, faceEdges, padFaces, PAD } from '../src/render/globe/cubeTex';
import { GlobeCamera } from '../src/render/camera/globeCamera';
import { wrapAngle } from '../src/render/camera/orbitCamera';
import { GlobeHeightField, SphereGround } from '../src/render/globe/globeGround';
import { sphereGradients } from '../src/render/globe/globePass';
import { hullBelowHorizon, SphereCdlodSelector, type SphereNode } from '../src/render/terrain/cdlodSphere';
import { faceDir, latLonDir } from '../src/shared/cube';
import { Rng } from '../src/shared/rng';

describe('cube-face texture padding (research 10 §6.2)', () => {
  const n = 16;
  const g = cubeGrid(n, 652e3);
  const rng = new Rng(5);
  const field = Float32Array.from({ length: 6 * n * n }, () => rng.float() * 100);

  it('derives the same 24 seam edges as the generator', () => {
    const edges = faceEdges();
    expect(edges.length).toBe(24);
    for (let k = 0; k < 24; k++) expect(edges[k]).toEqual(g.edges[k]);
  });

  it('border strips hold exactly the neighbouring face’s cells (generator halo convention)', () => {
    const m = n + 2 * PAD;
    const padded = padFaces(field, n);
    const ref = new Float32Array(m * m);
    for (let f = 0; f < 6; f++) {
      padFace(g, field, f, PAD, ref);
      for (let y = 0; y < m; y++) {
        for (let x = 0; x < m; x++) {
          const corner = (x < PAD || x >= PAD + n) && (y < PAD || y >= PAD + n);
          if (corner) continue;
          expect(padded[f * m * m + y * m + x]).toBe(ref[y * m + x]);
        }
      }
    }
  });

  it('seam texels equal the cells of the neighbouring face, and corners agree from all three faces', () => {
    const m = n + 2 * PAD;
    const padded = padFaces(field, n);
    const at = (f: number, x: number, y: number): number => padded[f * m * m + (y + PAD) * m + x + PAD];
    for (let f = 0; f < 6; f++) {
      for (let t = 0; t < n; t++) {
        // One texel beyond the east side is the mirror cell on the next face.
        expect(at(f, n, t)).toBe(field[acrossCell(n, f, 1, t, 0)]);
        expect(at(f, -1, t)).toBe(field[acrossCell(n, f, 0, t, 0)]);
      }
    }
    // Bilinear sample at each face corner (between the 4 texels around it) is the same from every face.
    const cornerSample = (f: number, cx: number, cy: number): number => {
      const xs = cx === 0 ? [-1, 0] : [n - 1, n];
      const ys = cy === 0 ? [-1, 0] : [n - 1, n];
      return 0.25 * (at(f, xs[0], ys[0]) + at(f, xs[1], ys[0]) + at(f, xs[0], ys[1]) + at(f, xs[1], ys[1]));
    };
    const byCorner = new Map<string, number[]>();
    const q = Math.PI / 4;
    for (let f = 0; f < 6; f++) {
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const key = cornerKey(f, cx === 0 ? -q : q, cy === 0 ? -q : q);
        const list = byCorner.get(key) ?? [];
        list.push(cornerSample(f, cx, cy));
        byCorner.set(key, list);
      }
    }
    expect(byCorner.size).toBe(8);
    for (const list of byCorner.values()) {
      expect(list.length).toBe(3);
      for (const v of list) expect(v).toBeCloseTo(list[0], 4);
    }
  });
});

describe('globe surface gradients', () => {
  it('match the analytic gradient of a smooth field, also on face borders', () => {
    const n = 64;
    const R = 652e3;
    const d = new Float64Array(3);
    const h = new Float32Array(6 * n * n);
    const dirs = new Float64Array(6 * n * n * 3);
    for (let f = 0; f < 6; f++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = (f * n + y) * n + x;
          faceDir(f, ((x + 0.5) / n - 0.5) * (Math.PI / 2), ((y + 0.5) / n - 0.5) * (Math.PI / 2), d);
          dirs.set(d, i * 3);
          h[i] = 5000 + 3000 * d[2];
        }
      }
    }
    const g = sphereGradients(h, n, R);
    let worst = 0;
    for (let i = 0; i < 6 * n * n; i++) {
      const z = dirs[i * 3 + 2];
      // ∇(3000·z) on the sphere of radius R: (3000 / R)(ẑ − z·p̂).
      const ex = (3000 / R) * (0 - z * dirs[i * 3]);
      const ey = (3000 / R) * (0 - z * dirs[i * 3 + 1]);
      const ez = (3000 / R) * (1 - z * z);
      worst = Math.max(worst, Math.hypot(g[i * 4] - ex, g[i * 4 + 1] - ey, g[i * 4 + 2] - ez) / (3000 / R));
    }
    // Central differences over mirror cells at the seams: a few per cent at most.
    expect(worst).toBeLessThan(0.05);
  });
});

describe('globe camera (research 10 §6.4)', () => {
  const R = 652e3;
  const ground = new SphereGround(R, 800);
  const make = (lat: number, lon: number, distance: number, pitch = 0, bearing = 0): GlobeCamera => {
    const c = new GlobeCamera(ground);
    c.viewW = 1200;
    c.viewH = 800;
    c.lookAtLatLon(lat, lon);
    c.autoTilt = false;
    c.distance = distance;
    c.pitch = pitch;
    c.rotateBy(bearing, 0);
    return c;
  };
  const near = (a: { sx: number; sy: number } | null, x: number, y: number, tol: number): void => {
    expect(a).not.toBeNull();
    expect(Math.abs(a!.sx - x)).toBeLessThan(tol);
    expect(Math.abs(a!.sy - y)).toBeLessThan(tol);
  };

  it('picks the sphere under the cursor (ray–sphere), and the pick projects back to the pixel', () => {
    const c = make(20, 30, 2e5, 0.4, 0.7);
    const centre = c.pick(600, 400)!;
    expect(Math.hypot(centre.x, centre.y, centre.z)).toBeCloseTo(R + 800, 3);
    const t = c.target;
    expect(Math.hypot(centre.x - t.x, centre.y - t.y, centre.z - t.z)).toBeLessThan(1e-3);
    for (const [sx, sy] of [[100, 700], [1100, 650], [300, 420]] as const) {
      const p = c.pick(sx, sy)!;
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(R + 800, 3);
      near(c.project(p), sx, sy, 1e-6);
    }
    // From space, a ray past the limb misses.
    const far = make(0, 0, 3e6);
    far.fitWorld();
    expect(far.pick(2, 400)).toBeNull();
  });

  it('grab pan keeps the grabbed point under the cursor, also at the poles', () => {
    const rng = new Rng(11);
    for (const lat of [0, 45, -60, 84, 86, 89.99, -89.9]) {
      // From space, north-up drags over a pole cannot always place a point anywhere (best effort there).
      for (const dist of Math.abs(lat) < 70 ? [3e3, 8e4, 2e6] : [3e3, 8e4]) {
        const c = make(lat, rng.float() * 360 - 180, dist, dist < 1e5 ? 0.6 : 0, rng.float() * 6);
        for (let k = 0; k < 5; k++) {
          const sx = 200 + rng.float() * 800;
          const sy = 200 + rng.float() * 400;
          const p = c.pick(sx, sy);
          if (!p) continue;
          const tx = sx + (rng.float() - 0.5) * 300;
          const ty = sy + (rng.float() - 0.5) * 200;
          // A point cannot be dragged off the planet's disc.
          if (dist > 1e6 && !c.pick(tx, ty)) continue;
          c.dragTo(p, tx, ty);
          expect(Number.isFinite(c.bearing + c.distance + c.dir.x + c.dir.y + c.dir.z)).toBe(true);
          near(c.project(p), tx, ty, 0.01);
        }
      }
    }
  });

  it('zoom to cursor keeps the point under the cursor from globe view to 10 m/px', () => {
    for (const lat of [10, 70, 88]) {
      const c = make(lat, 40, 2.5e6);
      c.minMetresPerPixel = 8;
      c.fitWorld();
      const sx = 760, sy = 330;
      let p = c.pick(sx, sy)!;
      expect(p).not.toBeNull();
      while (c.metresPerPixel() > 10) {
        const before = c.metresPerPixel();
        c.pinchAt(sx, sy, 0.8);
        near(c.project(p), sx, sy, 0.5);
        p = c.pick(sx, sy)!;
        if (c.metresPerPixel() >= before) break;
      }
      expect(c.metresPerPixel()).toBeLessThan(11);
      // Eased wheel zoom, through update().
      const q = c.pick(300, 600)!;
      c.zoomAt(300, 600, 3);
      for (let i = 0; i < 60; i++) c.update(1 / 60);
      near(c.project(q), 300, 600, 0.5);
    }
  });

  it('fit shows the whole planet, north up and untilted', () => {
    const c = make(35, -120, 5e3, 0.8, 1.2);
    c.fitWorld();
    expect(c.pitch).toBe(0);
    expect(Math.abs(c.bearing)).toBeLessThan(1e-9);
    // The planet's angular radius fits the narrower half-angle with ~10 % to spare.
    const e = c.eye();
    const angR = Math.asin(R / Math.hypot(e.x, e.y, e.z));
    const half = Math.atan(Math.tan(c.fovY / 2) * Math.min(1, c.viewW / c.viewH));
    expect(angR).toBeLessThan(half);
    expect(angR).toBeGreaterThan(half * 0.85);
    // Top and bottom screen edges see space; the centre sees the target.
    expect(c.pick(600, 1)).toBeNull();
    expect(c.pick(600, 799)).toBeNull();
    expect(c.pick(600, 400)).not.toBeNull();
    // North is up: a point north of the target projects straight above the centre.
    const [lat, lon] = c.latLon();
    const nd = new Float64Array(3);
    latLonDir(lat + 5, lon, nd);
    const pn = c.project({ x: nd[0] * R, y: nd[1] * R, z: nd[2] * R })!;
    expect(Math.abs(pn.sx - 600)).toBeLessThan(1e-6);
    expect(pn.sy).toBeLessThan(400);
  });

  it('pans across a pole without NaN or a spin, and the compass bearing stays defined', () => {
    const c = make(80, 10, 2e4, 0.3, 0);
    let lastB = c.bearing;
    let flips = 0;
    for (let i = 0; i < 2000; i++) {
      c.panBy(0, 1000);
      expect(Number.isFinite(c.bearing + c.dir.x + c.dir.y + c.dir.z + c.pitch)).toBe(true);
      // Over the pole the heading flips by π (north becomes south); otherwise it barely changes per step.
      const d = Math.abs(wrapAngle(c.bearing - lastB));
      if (d > 0.05) {
        expect(Math.abs(d - Math.PI)).toBeLessThan(0.05);
        flips++;
      }
      lastB = c.bearing;
    }
    // 2,000 km from 80° N across the pole: now on the far side, heading south.
    expect(flips).toBe(1);
    expect(c.latLon()[0]).toBeLessThan(85);
    expect(Math.abs(Math.abs(c.bearing) - Math.PI)).toBeLessThan(0.05);
  });
});

describe('sphere CDLOD selection (research 10 §6.1)', () => {
  const R = 652e3;
  const n = 64;
  // Smooth bumps up to ~6 km, sea below.
  const data = new Float32Array(6 * n * n);
  const d = new Float64Array(3);
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        faceDir(f, ((x + 0.5) / n - 0.5) * (Math.PI / 2), ((y + 0.5) / n - 0.5) * (Math.PI / 2), d);
        data[(f * n + y) * n + x] = 4000 * Math.sin(5 * d[0] + 2) * Math.cos(4 * d[1] - 1) + 2000 * d[2];
      }
    }
  }
  const layer = { id: 'elevation', label: 'Elevation', stage: 'refine', kind: 'elevation', w: n, h: n, worldKm: 1024, radiusKm: R / 1000, faces: 6, unit: 'm', min: -6000, max: 6000, data } as const;
  const hf = new GlobeHeightField({ ...layer });
  hf.exaggeration = 1.5;
  const noPlanes = new Float64Array(24).fill(0);
  for (let i = 0; i < 6; i++) noPlanes[i * 4 + 3] = Infinity;
  const settings = (cam: GlobeCamera): { maxDepth: number; vertexPx: number; pxPerRad: number; boundsPad: number } => ({
    maxDepth: SphereCdlodSelector.depthFor(512), vertexPx: 3, pxPerRad: cam.viewH / (2 * Math.tan(cam.fovY / 2)), boundsPad: 0,
  });
  const poses = (): GlobeCamera[] => {
    const rng = new Rng(3);
    const out: GlobeCamera[] = [];
    for (let k = 0; k < 24; k++) {
      const c = new GlobeCamera(hf);
      c.viewW = 1400;
      c.viewH = 900;
      c.minMetresPerPixel = 4;
      // Bias toward face seams and corners: latitudes ±35° and longitudes near ±45°, plus random poses.
      const lat = k % 3 === 0 ? 35.26 * (k % 2 ? 1 : -1) : rng.float() * 180 - 90;
      const lon = k % 3 === 0 ? 45 : rng.float() * 360 - 180;
      c.lookAtLatLon(lat, lon);
      c.autoTilt = false;
      c.distance = Math.exp(Math.log(2e3) + rng.float() * Math.log(1e3));
      c.pitch = rng.float() * 1.0;
      c.rotateBy(rng.float() * 6, 0);
      c.update(0);
      out.push(c);
    }
    return out;
  };

  /** The selected node containing a direction, or null. */
  const nodeAt = (nodes: readonly SphereNode[], x: number, y: number, z: number): SphereNode | null => {
    const fa = new Float64Array(3);
    dirToFaceAngles(x, y, z, fa);
    for (const nd of nodes) {
      if (nd.face === fa[0] && fa[1] >= nd.a0 && fa[1] < nd.a0 + nd.size && fa[2] >= nd.b0 && fa[2] < nd.b0 + nd.size) return nd;
    }
    return null;
  };

  it('neighbouring nodes differ by at most one level, also across face seams', () => {
    const sel = new SphereCdlodSelector();
    sel.keepNodes = true;
    let seamPairs = 0;
    for (const cam of poses()) {
      sel.select(hf, cam.eye(), noPlanes, settings(cam));
      const nodes = sel.nodes.slice();
      expect(nodes.length).toBeGreaterThan(0);
      for (const nd of nodes) {
        // Probe just outside each side at three points along it.
        const e = nd.size * 1e-4;
        for (const t of [0.1, 0.5, 0.9]) {
          for (const [a, b] of [[nd.a0 - e, nd.b0 + t * nd.size], [nd.a0 + nd.size + e, nd.b0 + t * nd.size], [nd.a0 + t * nd.size, nd.b0 - e], [nd.a0 + t * nd.size, nd.b0 + nd.size + e]]) {
            faceDir(nd.face, a, b, d);
            const other = nodeAt(nodes, d[0], d[1], d[2]);
            if (!other) continue;
            if (other.face !== nd.face) seamPairs++;
            expect(Math.abs(other.level - nd.level)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
    expect(seamPairs).toBeGreaterThan(50);
  });

  it('horizon culling only removes nodes whose whole surface is hidden by the planet', () => {
    const sel = new SphereCdlodSelector();
    sel.keepNodes = true;
    let culled = 0;
    const cams = poses();
    // Add whole-planet views, where about half of the sphere is behind it.
    for (const lat of [0, 50]) {
      const c = new GlobeCamera(hf);
      c.viewW = 1400;
      c.viewH = 900;
      c.lookAtLatLon(lat, 20);
      c.fitWorld();
      cams.push(c);
    }
    const pt = new Float64Array(3);
    for (const cam of cams) {
      const eye = cam.eye();
      sel.select(hf, eye, noPlanes, settings(cam));
      for (const nd of sel.culled) {
        culled++;
        for (let j = 0; j <= 8; j++) {
          for (let i = 0; i <= 8; i++) {
            faceDir(nd.face, nd.a0 + (i / 8) * nd.size, nd.b0 + (j / 8) * nd.size, d);
            const r = R + hf.heightAtDir(d[0], d[1], d[2]);
            pt[0] = d[0] * r;
            pt[1] = d[1] * r;
            pt[2] = d[2] * r;
            expect(hullBelowHorizon(pt, 1, eye, R)).toBe(true);
          }
        }
      }
      // Every visible surface point is covered by a selected node.
      const rng = new Rng(9);
      for (let k = 0; k < 300; k++) {
        const z = rng.float() * 2 - 1;
        const phi = rng.float() * 2 * Math.PI;
        const s = Math.sqrt(1 - z * z);
        const r = R + hf.heightAtDir(s * Math.cos(phi), s * Math.sin(phi), z);
        pt[0] = s * Math.cos(phi) * r;
        pt[1] = s * Math.sin(phi) * r;
        pt[2] = z * r;
        if (hullBelowHorizon(pt, 1, eye, R)) continue;
        expect(nodeAt(sel.nodes, pt[0], pt[1], pt[2])).not.toBeNull();
      }
    }
    expect(culled).toBeGreaterThan(10);
  });
});

/** Corner direction rounded to a key (the same corner seen from its three faces). */
function cornerKey(f: number, a: number, b: number): string {
  const d = new Float64Array(3);
  faceDir(f, a, b, d);
  return [...d].map((v) => Math.round(v * 1000)).join(',');
}
