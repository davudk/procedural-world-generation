/**
 * Landforms on the cube-sphere (research 10 §5.8, Sphere phase 4a): stamps are continuous across
 * seams and cube corners, spacing and lines cross seams, coast fetch rays continue over seams, there
 * is no map-edge rule (fixed = the sea), and the stage is deterministic with valid feature positions.
 */
import { describe, expect, it } from 'vitest';
import { angle, cubeGrid, latitudes, type CubeGrid } from '../src/gen/grid/cube';
import { cellFace, cellIndex } from '../src/gen/grid/grid';
import { COAST, classifyCoast } from '../src/gen/landforms/coast/classify';
import { chamferNearest, line4 } from '../src/gen/landforms/coast/grid';
import { DiskSet, settleFixed, snapshot, stampRadial } from '../src/gen/landforms/profiles';
import { spherePos } from '../src/gen/landforms/sphere';
import type { LandformCtx } from '../src/gen/landforms/types';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { GlacialExtra } from '../src/gen/stages/glacial';
import type { LandformsExtra } from '../src/gen/stages/landforms';
import type { ClimateExtra } from '../src/gen/stages/climate';
import { resolve } from '../src/shared/config/resolve';
import { faceDir } from '../src/shared/cube';
import { hashBytes, hashValue } from '../src/shared/hash';

/** 64² faces of 10 km cells. */
const N = 64;
const CELL_KM = 10;
const grid = (): CubeGrid => cubeGrid(N, (CELL_KM * 1000 * N) / (Math.PI / 2));

/** A bare landform context on a cube grid (only what the helpers under test read). */
function ctx(g: CubeGrid, h: Float32Array, fixed: Uint8Array, extra: Partial<LandformCtx> = {}): LandformCtx {
  return { grid: g, n: g.n, cellKm: g.cellKm, h, fixed, ice: new Float32Array(g.cells), features: [], masks: new Map(), stats: {}, ...extra } as LandformCtx;
}

/** Great-circle km from the encoded position (x, y) to the centre of cell i. */
function kmTo(g: CubeGrid, x: number, y: number, i: number): number {
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  spherePos(g).dir(x, y, p);
  g.position(i, q);
  return (g.radiusM / 1000) * angle(p, q);
}

describe('sphere landform stamps', () => {
  const g = grid();
  const W = g.n * g.cellKm;
  const S = spherePos(g).S;
  // A seam point (face 0's east edge, half way up) and a cube corner (face 0's north-east corner).
  const sites: [string, number, number][] = [['seam', W, W / 2], ['cube corner', W, 0], ['beyond the seam (face 0 chart)', W + 35, W / 3]];
  for (const [name, u, v] of sites) {
    it(`an 'add' cone on a ${name} follows the geodesic distance on every face, each cell once`, () => {
      const h = new Float32Array(g.cells);
      const c = ctx(g, h, new Uint8Array(g.cells));
      const R = 120;
      const touched = stampRadial(c, 0 * S + u, v, R, 'add', (r) => 1000 * (1 - r / R));
      const faces = new Set<number>();
      let inside = 0;
      for (let i = 0; i < g.cells; i++) {
        const d = kmTo(g, u, v, i);
        const want = d <= R ? 1000 * (1 - d / R) : 0;
        if (want > 0) {
          inside++;
          faces.add(cellFace(g, i));
        }
        // Exact profile of the geodesic distance: no clipping at a face edge, no double stamp.
        expect(Math.abs(h[i] - want), `cell ${i} (face ${cellFace(g, i)})`).toBeLessThan(0.05);
      }
      expect(faces.size).toBeGreaterThanOrEqual(name === 'cube corner' ? 3 : 2);
      expect(touched).toBe(inside);
    });
  }

  it("a supersampled 'max' stamp across a seam is continuous (neighbour steps match the interior)", () => {
    const h = new Float32Array(g.cells);
    const c = ctx(g, h, new Uint8Array(g.cells));
    // Smooth dome of 25 km, sampled 1×1… so check its gradient: across-seam neighbour differences
    // stay within the largest difference between interior neighbours at the same distance.
    stampRadial(c, W, W / 2, 25, 'max', (r) => 500 * (1 - (r / 25) ** 2));
    let maxStep = 0;
    let maxSeamStep = 0;
    for (let i = 0; i < g.cells; i++) {
      for (let k = 0; k < 8; k++) {
        const j = g.nbr(i, k);
        if (j < 0) continue;
        const step = Math.abs(h[i] - h[j]) / (g.dist(i, k) / 1000);
        if (cellFace(g, i) === cellFace(g, j)) maxStep = Math.max(maxStep, step);
        else maxSeamStep = Math.max(maxSeamStep, step);
      }
    }
    expect(maxStep).toBeGreaterThan(0);
    expect(maxSeamStep).toBeLessThan(maxStep * 1.25);
  });

  it('spacing tests use great-circle distance across seams', () => {
    const d = new DiskSet(50, g);
    // Two points 10 km either side of the face 0 / face 1 seam.
    const sp = spherePos(g);
    d.add(W - 5, W / 2);
    const across = sp.chart(1, 5, W / 2);
    expect(d.free(across.x, across.y, 20)).toBe(false);
    expect(d.free(across.x, across.y, 9)).toBe(true);
  });
});

describe('sphere coast grid helpers', () => {
  const g = grid();

  it('chamferNearest converges across seams (equals the 1 / 1.4 chamfer metric from a cube corner)', () => {
    const src = new Uint8Array(g.cells);
    const s0 = cellIndex(g, g.n - 1, 0, 0);
    src[s0] = 1;
    const { dist, nearest } = chamferNearest(src, g);
    // Reference: Bellman–Ford over the same 8-neighbour graph and weights (in float32, like the chamfer).
    const ref = new Float32Array(g.cells).fill(1e9);
    ref[s0] = 0;
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < g.cells; i++) {
        for (let k = 0; k < 8; k++) {
          const j = g.nbr(i, k);
          if (j < 0) continue;
          const w = k === 1 || k === 3 || k === 4 || k === 6 ? 1 : 1.4;
          if (ref[j] + w < ref[i] - 1e-4) {
            ref[i] = ref[j] + w;
            changed = true;
          }
        }
      }
    }
    let worst = 0;
    for (let i = 0; i < g.cells; i++) worst = Math.max(worst, Math.abs(dist[i] - ref[i]));
    expect(worst).toBeLessThan(1e-2);
    for (let i = 0; i < g.cells; i++) expect(nearest[i]).toBe(s0);
  });

  it('line4 crosses a seam and a cube corner 4-connected', () => {
    const is4 = (i: number, j: number): boolean => [1, 3, 4, 6].some((k) => g.nbr(i, k) === j);
    const pairs: [number, number][] = [
      [cellIndex(g, g.n - 4, 20, 0), g.chartCell(0, g.n + 3, 25)],
      // Past face 0's north-east cube corner (both edges at once).
      [cellIndex(g, g.n - 3, 2, 0), g.chartCell(0, g.n + 1, -3)],
    ];
    for (const [a, b] of pairs) {
      expect(cellFace(g, b)).not.toBe(0);
      const path = line4(g, a, b);
      expect(path[0]).toBe(a);
      expect(path[path.length - 1]).toBe(b);
      for (let t = 1; t < path.length; t++) expect(is4(path[t - 1], path[t]), `step ${t}`).toBe(true);
      expect(path.length).toBeLessThan(20);
    }
  });

  it('settleFixed has no map-edge rule: seam sea raised above 0 becomes land', () => {
    const h = new Float32Array(g.cells).fill(-100);
    const fixed = new Uint8Array(g.cells).fill(1);
    const c = ctx(g, h, fixed);
    const s = snapshot(c);
    const seam = cellIndex(g, g.n - 1, 10, 0);
    const corner = cellIndex(g, 0, 0, 2);
    h[seam] = 50;
    h[corner] = 50;
    settleFixed(c, s);
    expect(fixed[seam]).toBe(0);
    expect(fixed[corner]).toBe(0);
  });
});

describe('sphere coast exposure', () => {
  /**
   * Mean exposure of the west and east shores (sea-pointing normal within 30° of east / west) of a
   * 150 km round sea centred at face 0 angles (a, 0) on the equator.
   */
  const ringExposure = (a: number): { west: number; east: number; faces: number } => {
    const g = grid();
    const centre = new Float64Array(3);
    faceDir(0, a, 0, centre);
    const h = new Float32Array(g.cells);
    const fixed = new Uint8Array(g.cells);
    const p = new Float64Array(3);
    const Rk = g.radiusM / 1000;
    for (let i = 0; i < g.cells; i++) {
      g.position(i, p);
      const sea = Rk * angle(p, centre) < 150;
      h[i] = sea ? -500 : 200;
      fixed[i] = sea ? 1 : 0;
    }
    const lat = latitudes(g);
    const c = ctx(g, h, fixed, { climate: { lat } as unknown as ClimateExtra, num: () => 0.5 });
    const info = classifyCoast(c);
    const sum = [0, 0];
    const cnt = [0, 0];
    const faces = new Set<number>();
    for (let k = 0; k < info.cells.length; k++) {
      faces.add(cellFace(g, info.cells[k]));
      expect(info.cls[k]).not.toBe(COAST.NONE);
      // Equatorial faces: columns run east, so nx is the eastward component.
      const side = info.nx[k] > 0.87 ? 0 : info.nx[k] < -0.87 ? 1 : -1;
      if (side < 0) continue;
      sum[side] += info.exposure[k];
      cnt[side]++;
    }
    expect(Math.min(cnt[0], cnt[1])).toBeGreaterThan(5);
    return { west: sum[0] / cnt[0], east: sum[1] / cnt[1], faces: faces.size };
  };

  it('fetch rays cross seams: a round sea on a seam is as exposed as the same sea inside a face', () => {
    // The two seas differ by a rotation about the polar axis, which keeps the latitude wind belts.
    const inFace = ringExposure(0);
    const onSeam = ringExposure(Math.PI / 4);
    expect(inFace.faces).toBe(1);
    expect(onSeam.faces).toBe(2);
    // The west shore faces the open sea upwind of the trades (on the seam sea its rays cross onto face 1).
    expect(inFace.west).toBeGreaterThan(0.6);
    expect(inFace.west).toBeGreaterThan(inFace.east + 0.3);
    // A ray stopped, or read on the wrong face, at the seam would change the seam sea's shores.
    expect(Math.abs(onSeam.west - inFace.west)).toBeLessThan(0.02);
    expect(Math.abs(onSeam.east - inFace.east)).toBeLessThan(0.02);
  });
});

/** Plates → landforms on the default small planet (preview), with the outputs hashed. */
async function sphereWorld(seed: number): Promise<{ L: LandformsExtra; G: GlacialExtra; layers: { faces?: number; data: ArrayLike<number> }[]; hash: number }> {
  const stages = STAGES.slice(0, STAGES.findIndex((s) => s.id === 'landforms') + 1);
  const p = new Pipeline(stages);
  let error = '';
  await p.run(resolve({ seed, archetype: 'earth', pins: { worldShape: 'sphere' } }), 'preview', 1, (m) => {
    if (m.type === 'error') error = m.message;
  }, () => false);
  if (error) throw new Error(error);
  const out = p.output('landforms')!;
  const L = out.extra as LandformsExtra;
  let hash = hashBytes(L.h, hashBytes(L.fixed));
  for (const [id, m] of L.masks) hash = hashBytes(m, hashValue(id, hash));
  hash = hashValue(JSON.stringify(L.features), hash);
  return { L, G: p.output('glacial')!.extra as GlacialExtra, layers: out.layers, hash };
}

describe('landforms stage on a sphere preview', () => {
  it('is deterministic, keeps fixed = the sea and writes valid sphere positions and layers', async () => {
    const a = await sphereWorld(11);
    const b = await sphereWorld(11);
    expect(b.hash).toBe(a.hash);
    const { L, G } = a;
    const cells = L.h.length;
    expect(cells).toBe(6 * L.n * L.n);
    // fixed cells are water; water fixed is closed under 8-adjacency (across seams); new seas join old ones.
    const g = cubeGrid(L.n, (L.cellKm * 1000 * L.n) / (Math.PI / 2));
    for (let i = 0; i < cells; i++) {
      if (L.fixed[i]) expect(L.h[i], `fixed land at ${i}`).toBeLessThanOrEqual(0);
      if (L.h[i] !== G.h[i] && !L.fixed[i] && L.h[i] <= 0) {
        // Unfixed water must not touch fixed water.
        for (let k = 0; k < 8; k++) {
          const j = g.nbr(i, k);
          if (j >= 0) expect(L.fixed[j] && L.h[j] <= 0, `open water ${i} next to sea ${j}`).toBeFalsy();
        }
      }
    }
    const W = L.n * L.cellKm * 1000;
    const types = new Set<string>();
    for (const f of L.features) {
      types.add(f.type);
      expect(f.face, f.type).toBeGreaterThanOrEqual(0);
      expect(f.face, f.type).toBeLessThanOrEqual(5);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x).toBeLessThanOrEqual(W);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeLessThanOrEqual(W);
    }
    for (const t of ['stratovolcano', 'karst', 'sea-cliff', 'reef']) expect(types.has(t), t).toBe(true);
    for (const [, m] of L.masks) expect(m.length).toBe(cells);
    expect(a.layers.length).toBe(L.masks.size);
    for (const l of a.layers) {
      expect(l.faces).toBe(6);
      expect(l.data.length).toBe(cells);
    }
  }, 30_000);
});
