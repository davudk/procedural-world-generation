import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GLOBE_DETAIL_GLSL, GLOBE_NOISE_GLSL, noiseOrigin } from '../src/render/glsl/globeDetail';
import {
  DG, GlobeDetailGround, GlobeHeightFn, wetLevel, chartAngles, chartGrad, hash3U, noise3, tileKey, tileLattice, tileOfKey, tileStride,
  tileWeight1, type TileLattice, type TileSource,
} from '../src/render/height/globeHeightFn';
import { DN } from '../src/render/height/heightFn';
import {
  TileCache, buildTileCpu, tileBounds, extractTile, prepareGlobe, prepareTile, runSync, tileAtDir, type GlobeDetailWorld, type PreparedGlobe,
} from '../src/render/globe/detailTiles';
import { GLOBE_TILE_SOURCES } from '../src/render/globe/globeDetail';
import { DETAIL_BUILD_SOURCES } from '../src/render/terrain/detail/detailMap';
import { DETAIL_GLSL, NOISE_GLSL } from '../src/render/glsl/detail';
import { GlobeHeightField } from '../src/render/globe/globeGround';
import { faceDir } from '../src/shared/cube';
import type { Layer } from '../src/shared/protocol';

const F = Math.fround;
const M32 = (1n << 32n) - 1n;
const mulU = (a: bigint, b: number): bigint => (a * BigInt(b >>> 0)) & M32;

function refHash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = mulU(BigInt(ix >>> 0), DN.M1) ^ mulU(BigInt(iy >>> 0), DN.M2) ^ mulU(BigInt(iz >>> 0), DG.M4) ^ mulU(BigInt(seed >>> 0), DN.M3);
  h ^= h >> 16n;
  h = mulU(h, DN.F1);
  h ^= h >> 15n;
  h = mulU(h, DN.F2);
  h ^= h >> 16n;
  return Number(h);
}

/** Line-by-line float32 port of GLSL gNoise at eye + rel, with the eye split into a lattice tile and offset. */
function refNoise3(eye: number[], rel: number[], lam: number, seed: number): number[] {
  const [tile, off] = noiseOrigin({ x: eye[0], y: eye[1], z: eye[2] });
  const l = [0, 1, 2].map((k) => F(F(off[k]) + F(rel[k])));
  const q = l.map((v) => F(v / lam));
  const fq = q.map(Math.floor);
  const fr = q.map((v, k) => F(v - fq[k]));
  const i = [0, 1, 2].map((k) => tile[k] * (DN.TILE / lam) + fq[k]);
  const w = fr.map((x) => F(F(F(x * x) * x) * F(F(x * F(F(x * 6) - 15)) + 10)));
  const dw = fr.map((x) => F(F(F(30 * x) * x) * F(F(x * F(x - 2)) + 1)));
  const val = (dx: number, dy: number, dz: number): number => F((refHash3(i[0] + dx, i[1] + dy, i[2] + dz, seed) >>> 8) * (2 / 16777216) - 1);
  const a = val(0, 0, 0), b = val(1, 0, 0), c = val(0, 1, 0), d = val(1, 1, 0);
  const e = val(0, 0, 1), g = val(1, 0, 1), h = val(0, 1, 1), kk = val(1, 1, 1);
  const k1 = F(b - a), k2 = F(c - a), k3 = F(e - a), k4 = F(F(F(a - b) - c) + d), k5 = F(F(F(a - c) - e) + h), k6 = F(F(F(a - b) - e) + g);
  const k7 = F(-a + b + c - d + e - g - h + kk);
  const [x, y, z] = w;
  const n = F(a + k1 * x + k2 * y + k3 * z + k4 * x * y + k5 * y * z + k6 * z * x + k7 * x * y * z);
  return [n, F((dw[0] * (k1 + k4 * y + k6 * z + k7 * y * z)) / lam), F((dw[1] * (k2 + k5 * z + k4 * x + k7 * z * x)) / lam), F((dw[2] * (k3 + k6 * x + k5 * y + k7 * x * y)) / lam)];
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- A tiny synthetic planet: 6 × 16² cells of 2 km, continents from 3D noise --------------------

const N = 16;
const CELL = 2000;
const R = (CELL * N) / (Math.PI / 2);
const TILE_N = 64;

function planet(seed = 5, relief = 900): GlobeDetailWorld {
  const elev = new Float32Array(6 * N * N);
  const d = new Float64Array(3);
  const o = new Float64Array(4);
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        faceDir(f, ((x + 0.5) / N - 0.5) * (Math.PI / 2), ((y + 0.5) / N - 0.5) * (Math.PI / 2), d);
        const v = noise3(d[0] * R, d[1] * R, d[2] * R, 8192, 17, o)[0] + 0.5 * noise3(d[0] * R, d[1] * R, d[2] * R, 4096, 18, o)[0];
        elev[(f * N + y) * N + x] = relief * v + 60;
      }
    }
  }
  return { n: N, radius: R, seed, elevation: elev };
}

const prepCache = new Map<number, PreparedGlobe>();
function prepared(seed = 5): PreparedGlobe {
  let p = prepCache.get(seed);
  if (!p) {
    p = runSync(prepareGlobe(planet(seed), tileLattice(N, R, TILE_N)));
    prepCache.set(seed, p);
  }
  return p;
}

const builtCache = new Map<number, Float32Array>();
function tileData(key: number): Float32Array {
  let t = builtCache.get(key);
  if (!t) {
    const pg = prepared();
    t = extractTile(runSync(buildTileCpu(prepareTile(pg, key), 4, { talus: 0.75, thermalRate: 0.5 })), pg.lattice);
    builtCache.set(key, t);
  }
  return t;
}

/** Every tile resident (built on demand) at full fade. */
function allTiles(l: TileLattice): TileSource {
  return { lattice: l, tile: (key) => ({ data: tileData(key), fade: 1 }) };
}

function heightFn(tiles: TileSource | null): GlobeHeightFn {
  const pg = prepared();
  return new GlobeHeightFn({ n: N, radius: R, macroPad: pg.macroPad, control: pg.controlPad, params: pg.params, tiles });
}

/** Max |Δh| between consecutive samples along the great circle from direction p to q (both unit). */
function maxStep(fn: GlobeHeightFn, p: number[], q: number[], steps: number, pxFoot: number): number {
  const fa = new Float64Array(3);
  const out = new Float64Array(4);
  let prev = Number.NaN;
  let worst = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const v = [0, 1, 2].map((k) => p[k] * (1 - t) + q[k] * t);
    const L = Math.hypot(v[0], v[1], v[2]);
    const fd = (k: number): number => v[k] / L;
    // dirToFaceAngles inline via chart of the dominant face
    const ax = Math.abs(fd(0)), ay = Math.abs(fd(1)), az = Math.abs(fd(2));
    const face = ax >= ay && ax >= az ? (fd(0) > 0 ? 0 : 2) : ay >= az ? (fd(1) > 0 ? 1 : 3) : fd(2) > 0 ? 4 : 5;
    chartAngles(face, fd(0), fd(1), fd(2), fa);
    const h = fn.sample(face, fa[0], fa[1], pxFoot, out)[0];
    if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(h - prev));
    prev = h;
  }
  return worst;
}

const dirOf = (face: number, a: number, b: number): number[] => {
  const d = new Float64Array(3);
  faceDir(face, a, b, d);
  return [d[0], d[1], d[2]];
};

describe('globe detail lattice', () => {
  it('sizes tiles for the default small planet and the low tier', () => {
    const hi = tileLattice(512, 652e3, 1024);
    expect([hi.k, hi.F, hi.N, hi.T]).toEqual([8, 4096, 1024, 4]);
    expect(hi.texelM).toBeGreaterThan(240);
    expect(hi.texelM).toBeLessThan(260);
    const lo = tileLattice(512, 652e3, 512);
    expect([lo.N, lo.T]).toEqual([512, 8]);
    expect(tileStride(hi) % 4).toBe(0);
    for (const key of [0, 17, 95]) expect(tileKey(...tileOfKey(key, 4), 4)).toBe(key);
  });

  it('tile weights are a partition of unity inside a face', () => {
    const l = tileLattice(512, 652e3, 1024);
    for (let p = -3; p < l.F + 3; p += 0.37) {
      let s = 0;
      for (let i = 0; i < l.T; i++) s += tileWeight1(p - i * l.N, l.N, l.B);
      if (p >= l.B && p <= l.F - l.B) expect(Math.abs(s - 1)).toBeLessThan(1e-9);
    }
  });

  it('chart gradients match finite differences of a 3D field', () => {
    const g = new Float64Array(4);
    const field = (d: number[]): number => 300 * d[0] + 200 * d[1] * d[2];
    for (const [f, a, b] of [[0, 0.1, -0.2], [4, 0.7, 0.3], [3, -0.6, 0.65]] as const) {
      const e = 1e-6;
      const ga = (field(dirOf(f, a + e, b)) - field(dirOf(f, a - e, b))) / (2 * e);
      const gb = (field(dirOf(f, a, b + e)) - field(dirOf(f, a, b - e))) / (2 * e);
      chartGrad(f, a, b, ga, gb, R, g);
      // The 3D gradient of a linear field restricted to the sphere is its tangential part / R.
      const d = dirOf(f, a, b);
      const full = [300, 200 * d[2], 200 * d[1]];
      const r = full[0] * d[0] + full[1] * d[1] + full[2] * d[2];
      for (let k = 0; k < 3; k++) expect(g[k + 1]).toBeCloseTo((full[k] - r * d[k]) / R, 6);
    }
  });
});

describe('globe noise (TS ↔ GLSL reference)', () => {
  it('3D hash matches a BigInt reference bit for bit, negative lattice indices included', () => {
    const r = rng(3);
    for (let k = 0; k < 2000; k++) {
      const ix = Math.floor((r() - 0.5) * 2 ** 22), iy = Math.floor((r() - 0.5) * 2 ** 22), iz = Math.floor((r() - 0.5) * 2 ** 22);
      const s = Math.floor(r() * 2 ** 32);
      expect(hash3U(ix, iy, iz, s)).toBe(refHash3(ix, iy, iz, s));
    }
  });

  it('TS noise3 at the sea-level point matches the float32 GLSL path (camera-relative split) at Earth radius', () => {
    const r = rng(9);
    const out = new Float64Array(4);
    for (const radius of [652e3, 6.371e6]) {
      for (let k = 0; k < 300; k++) {
        const u = [r() - 0.5, r() - 0.5, r() - 0.5];
        const L = Math.hypot(u[0], u[1], u[2]);
        const P = u.map((v) => (v / L) * radius);
        const eye = P.map((v, i) => v * 1.0003 + (r() - 0.5) * 30_000 * (i + 1));
        const rel = P.map((v, i) => v - eye[i]);
        const lam = 2 ** (4 + Math.floor(r() * 9));
        const seed = Math.floor(r() * 2 ** 32);
        noise3(P[0], P[1], P[2], lam, seed, out);
        const ref = refNoise3(eye, rel, lam, seed);
        expect(Math.abs(out[0] - ref[0])).toBeLessThan(2e-3);
        for (let c = 1; c < 4; c++) expect(Math.abs(out[c] - ref[c]) * lam).toBeLessThan(2e-2);
      }
    }
  });

  it('noise3 gradients match finite differences', () => {
    const out = new Float64Array(4);
    const o2 = new Float64Array(4);
    const p = [123_456.7, -98_765.4, 4_321_000.1];
    noise3(p[0], p[1], p[2], 64, 7, out);
    for (let c = 0; c < 3; c++) {
      const q = p.slice();
      q[c] += 0.01;
      const a = noise3(q[0], q[1], q[2], 64, 7, o2)[0];
      q[c] -= 0.02;
      const b = noise3(q[0], q[1], q[2], 64, 7, o2)[0];
      expect((a - b) / 0.02).toBeCloseTo(out[c + 1], 5);
    }
  });

  it('leaves the flat detail shaders byte-identical (the build passes are shared through detailBuildSources)', () => {
    const h = (x: string): string => createHash('sha256').update(x).digest('hex').slice(0, 16);
    expect(h(JSON.stringify(DETAIL_BUILD_SOURCES))).toBe('e6b3e62cc0e8334c');
    expect(h(NOISE_GLSL)).toBe('a9ae814aa809876a');
    expect(h(DETAIL_GLSL)).toBe('613739c1ebb7cc2d');
  });

  it('GLSL is generated from the shared constants', () => {
    for (const c of [DN.M1, DN.M2, DN.M3, DG.M4, DN.F1, DN.F2, DN.OCT, DG.SEED_COAST]) expect(GLOBE_NOISE_GLSL).toContain(`0x${c.toString(16)}u`);
    expect(GLOBE_DETAIL_GLSL).toContain(`const int G_B = ${DG.BLEND};`);
    expect(GLOBE_DETAIL_GLSL).toContain('vec4 globeSample(int f, vec2 ang, vec3 rel, float pxFoot)');
    expect(GLOBE_DETAIL_GLSL).toContain('float globeSurface(int f, vec2 ang, vec3 rel, float pxFoot)');
    for (const [vs, fs] of Object.values(GLOBE_TILE_SOURCES)) {
      expect(vs.startsWith('#version 300 es')).toBe(true);
      expect(fs.startsWith('#version 300 es')).toBe(true);
      expect(fs).not.toMatch(/\bhalf\b/);
    }
  });
});

describe('globe detail tiles (CPU reference of the GPU build)', () => {
  it('a tile is a pure function of (seed, world, face, tile)', () => {
    const pg = prepared();
    const a = runSync(buildTileCpu(prepareTile(pg, 5), 2, { talus: 0.75, thermalRate: 0.5 }));
    const pg2 = runSync(prepareGlobe(planet(5), tileLattice(N, R, TILE_N)));
    const b = runSync(buildTileCpu(prepareTile(pg2, 5), 2, { talus: 0.75, thermalRate: 0.5 }));
    expect(b).toEqual(a);
    const c = runSync(buildTileCpu(prepareTile(prepared(6), 5), 2, { talus: 0.75, thermalRate: 0.5 }));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - c[i]));
    expect(diff).toBeGreaterThan(1);
  });

  it('stays within the bake + coast amplitude of the macro; water stays water and land stays land outside the coastal band', () => {
    const pg = prepared();
    const l = pg.lattice;
    const fn = heightFn(null);
    const p = pg.params;
    const bound = (DN.BAKE_BASE + DN.BAKE_ROUGH) * p.bakeAmpScale + DG.COAST_MAX + 1;
    let checked = 0;
    for (const key of [0, 9, 14, 22]) {
      const tp = prepareTile(pg, key);
      const t = tileData(key);
      const W = tileStride(l);
      const [face, ix, iy] = tileOfKey(key, l.T);
      const out = new Float64Array(4);
      for (let v = 0; v < l.N; v += 3) {
        for (let u = 0; u < l.N; u += 3) {
          const a = -Math.PI / 4 + (ix * l.N + u + 0.5) * l.delta;
          const b = -Math.PI / 4 + (iy * l.N + v + 0.5) * l.delta;
          const h = t[(v + l.M) * W + u + l.M];
          const m = fn.macroCubic(face, a, b, out)[0];
          expect(Math.abs(h - m)).toBeLessThan(bound);
          // Coastal band weight at this texel (bilinear of the local mask).
          const qx = (u + l.A + 0.5) / tp.k - 0.5, qy = (v + l.A + 0.5) / tp.k - 0.5;
          const cx = Math.floor(qx), cy = Math.floor(qy);
          let band = 0;
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) band = Math.max(band, tp.coast[Math.min(tp.nl - 1, cy + j) * tp.nl + Math.min(tp.nl - 1, cx + i)]);
          if (band === 0) {
            const hb = fn.macroBilinear(face, a, b, out)[0];
            expect(hb < 0 ? h <= -0.5 + 1e-3 : h >= 0.5 - 1e-3).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('is continuous across tile edges, a face seam and a cube corner (max step < 0.5 m)', () => {
    const pg = prepared();
    const l = pg.lattice;
    const fn = heightFn(allTiles(l));
    const span = l.N * l.delta;
    const Q = Math.PI / 4;
    const foot = 0.2 * l.texelM;
    const steps = 6000;
    const w = 12 * l.delta;
    // Across the tile edge inside face 0, across the face 0 | face 1 seam, and around the corner of faces 0, 1, 4.
    const paths: [number[], number[]][] = [
      [dirOf(0, -Q + span - w, 0.1), dirOf(0, -Q + span + w, 0.13)],
      [dirOf(0, Q - w, 0.2), dirOf(1, -Q + w, 0.22)],
      [dirOf(0, Q - w, -Q + 2 * w), dirOf(0, Q - 2 * w, -Q + w)],
      [dirOf(0, Q - w, -Q + w), dirOf(4, Q - w, Q - w)],
      [dirOf(1, -Q + w, -Q + 0.3 * w), dirOf(4, Q - 0.3 * w, Q - w)],
    ];
    for (const [p, q] of paths) {
      const len = R * Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
      const step = maxStep(fn, p, q, steps, foot);
      // Smooth terrain changes by at most slope × spacing; anything above 0.5 m would be a seam.
      expect(step).toBeLessThan(0.5);
      expect(len / steps).toBeLessThan(2);
    }
  });

  it('tiles on both sides of a seam agree closely in their shared band', () => {
    const pg = prepared();
    const l = pg.lattice;
    const ts = allTiles(l);
    const fnAll = heightFn(ts);
    const Q = Math.PI / 4;
    // Compare the blended surface with the single tile on each side, a few texels from the seam.
    const only = (key: number): TileSource => ({ lattice: l, tile: (k) => (k === key ? { data: tileData(k), fade: 1 } : null) });
    const out = new Float64Array(4);
    let worst = 0;
    for (let s = -0.6; s <= 0.6; s += 0.05) {
      const d = dirOf(0, Q - 3 * l.delta, s);
      const fa = new Float64Array(2);
      chartAngles(0, d[0], d[1], d[2], fa);
      const kA = tileAtDir(l, d[0], d[1], d[2]);
      const d1 = dirOf(1, -Q + 0.5 * l.delta, s);
      const kB = tileAtDir(l, d1[0], d1[1], d1[2]);
      const hA = heightFn(only(kA)).sample(0, fa[0], fa[1], 0.2 * l.texelM, out)[0];
      const hB = heightFn(only(kB)).sample(0, fa[0], fa[1], 0.2 * l.texelM, out)[0];
      worst = Math.max(worst, Math.abs(hA - hB));
      expect(Number.isFinite(fnAll.sample(0, fa[0], fa[1], 0.2 * l.texelM, out)[0])).toBe(true);
    }
    // Independent builds (own erosion, resampled apron) differ by tens of metres at most.
    expect(worst).toBeLessThan(80);
  });

  it('carves a river channel through a tile when rivers are given (the hydrology hook)', () => {
    const world = planet();
    const n = 40;
    const d0 = dirOf(0, -0.2, 0.05);
    const d1 = dirOf(0, 0.25, 0.1);
    const dirs: number[][] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const v = d0.map((x, k) => x * (1 - t) + d1[k] * t);
      const L = Math.hypot(v[0], v[1], v[2]);
      dirs.push(v.map((x) => x / L));
    }
    const zWater = Float32Array.from({ length: n }, (_, i) => 400 - 8 * i);
    world.rivers = {
      graph: {
        n, zWater, zBed: zWater.map((z) => z - 3), width: new Float32Array(n).fill(60),
        down: Int32Array.from({ length: n }, (_, i) => (i + 1 < n ? i + 1 : -1)),
      },
      nodeDir: (i, out) => out.set(dirs[i]),
    };
    const pg = runSync(prepareGlobe(world, tileLattice(N, R, TILE_N)));
    const key = tileAtDir(pg.lattice, d0[0], d0[1], d0[2]);
    const tp = prepareTile(pg, key);
    expect(tp.segCount).toBeGreaterThan(0);
    const raster = runSync(buildTileCpu(tp, 12, { talus: 0.75, thermalRate: 0.5 }));
    // The centreline: every segment's midpoint sits at or below its water surface.
    let checked = 0;
    for (let s = 0; s < tp.segCount; s++) {
      const o = s * 12;
      const x = 0.5 * (tp.segs[o] + tp.segs[o + 2]) / tp.texelM - 0.5;
      const y = 0.5 * (tp.segs[o + 1] + tp.segs[o + 3]) / tp.texelM - 0.5;
      if (x < 2 || y < 2 || x > tp.D - 3 || y > tp.D - 3) continue;
      const h = raster[Math.round(y) * tp.D + Math.round(x)];
      // The nearest texel centre can sit up to 0.7 texel along the segment: allow its full water drop.
      expect(h).toBeLessThanOrEqual(Math.max(tp.segs[o + 6], tp.segs[o + 7]) + 1);
      // …and erosion never digs it more than 1 m under the bed (ribbons don't float over a gorge).
      // (The nearest texel may sit up to a segment past its end, one more drop down the river.)
      const zb = Math.min(tp.segs[o + 4], tp.segs[o + 5]);
      expect(h).toBeGreaterThanOrEqual(zb - Math.abs(tp.segs[o + 4] - tp.segs[o + 5]) - 1.01);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('globe detail with the sphere hydrology', () => {
  it('keeps dry cells reached only by a lake\'s spread level as land (no ponds along valleys)', () => {
    // Below the spread level but with no real water nearby: not water, and free to lie below the level
    // (the effective level has sunk away, so the shader neither floods nor lids it).
    const [lo, hi] = tileBounds(59, 62.7, 0, 0);
    expect(hi).toBe(1e30);
    expect(lo).toBeLessThan(0);
    expect(wetLevel(62.7, 0)).toBeLessThan(-900);
    expect(wetLevel(62.7, 0.05)).toBe(62.7);
    // Next to real water the macro contour decides, as on flat maps.
    expect(tileBounds(59, 62.7, 0, 0.4)[1]).toBeCloseTo(62.2, 6);
    expect(tileBounds(64, 62.7, 0, 1)[0]).toBeCloseTo(63.2, 6);
  });

  it('keeps lakes under their level and shores dry, and the octaves never cross a lake level', () => {
    const world = planet();
    const elev = world.elevation as Float32Array;
    const level = new Float32Array(elev.length).fill(-10000);
    const cls = new Uint8Array(elev.length);
    // A lake at 300 m over all low land cells and the sea elsewhere below 0.
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] > 0 && elev[i] < 300) {
        level[i] = 300;
        cls[i] = 2;
      } else if (elev[i] < 0) {
        level[i] = 0;
        cls[i] = 1;
      }
    }
    world.waterLevel = level;
    world.waterClass = cls;
    const pg = runSync(prepareGlobe(world, tileLattice(N, R, TILE_N)));
    expect(pg.levelPad).not.toBeNull();
    const l = pg.lattice;
    const fn = new GlobeHeightFn({
      n: N, radius: R, macroPad: pg.macroPad, waterPad: pg.levelPad, control: pg.controlPad, params: pg.params,
      tiles: { lattice: l, tile: (k) => ({ data: extractTile(runSync(buildTileCpu(prepareTile(pg, k), 2, { talus: 0.75, thermalRate: 0.5 })), l), fade: 1 }) },
    });
    const cache = new Map<number, Float32Array>();
    const tiles: TileSource = {
      lattice: l,
      tile: (k) => {
        let t = cache.get(k);
        if (!t) cache.set(k, (t = extractTile(runSync(buildTileCpu(prepareTile(pg, k), 2, { talus: 0.75, thermalRate: 0.5 })), l)));
        return { data: t, fade: 1 };
      },
    };
    const det = new GlobeHeightFn({ ...fn.src, tiles });
    const flat = new GlobeHeightFn({ ...fn.src, tiles });
    flat.amp = 0;
    const out = new Float64Array(4);
    const b0 = new Float64Array(4);
    let lake = 0, dry = 0;
    for (let f = 0; f < 6; f++) {
      for (let y = 1; y < N - 1; y++) {
        for (let x = 1; x < N - 1; x++) {
          const i = (f * N + y) * N + x;
          if (cls[i] !== 2) continue;
          // Only cells whose 3×3 neighbourhood is all lake: inside the lake, away from its bilinear shore.
          let inner = true;
          for (let dy = -1; dy <= 1 && inner; dy++) for (let dx = -1; dx <= 1; dx++) if (cls[i + dy * N + dx] !== 2) inner = false;
          if (!inner) continue;
          const a = ((x + 0.5) / N - 0.5) * (Math.PI / 2), b = ((y + 0.5) / N - 0.5) * (Math.PI / 2);
          expect(det.sample(f, a, b, 4, out)[0]).toBeLessThan(300);
          expect(det.surface(f, a, b, 4)).toBeCloseTo(300, 6);
          lake++;
        }
      }
    }
    // Octaves never cross the lake level anywhere on face 0.
    for (let k = 0; k < 300; k++) {
      const a = -0.7 + 1.4 * ((k * 0.618) % 1), b = -0.7 + 1.4 * ((k * 0.377) % 1);
      const wl = det.waterLevel(0, a, b);
      if (wl < 100) continue;
      const h = det.sample(0, a, b, 4, out)[0];
      const h0 = flat.sample(0, a, b, 4, b0)[0];
      expect(Math.sign(h - wl)).toBe(Math.sign(h0 - wl));
      dry++;
    }
    expect(lake).toBeGreaterThan(0);
    expect(dry).toBeGreaterThan(10);
    // The bounds and the height function read the same levels as the shader.
    expect(pg.levelPad).toBe(pg.waterPad);
  });
});

describe('globe height function', () => {
  it('has no jumps on steep terrain: refined around the largest step, the step vanishes', () => {
    const pg = runSync(prepareGlobe(planet(5, 7000), tileLattice(N, R, TILE_N)));
    const l = pg.lattice;
    const built = new Map<number, Float32Array>();
    const tiles: TileSource = {
      lattice: l,
      tile: (key) => {
        let t = built.get(key);
        if (!t) built.set(key, (t = extractTile(runSync(buildTileCpu(prepareTile(pg, key), 0, { talus: 0.75, thermalRate: 0.5 })), l)));
        return { data: t, fade: 1 };
      },
    };
    const fn = new GlobeHeightFn({ n: N, radius: R, macroPad: pg.macroPad, control: pg.controlPad, params: pg.params, tiles });
    const Q = Math.PI / 4;
    const out = new Float64Array(4);
    const r = rng(21);
    const paths: [number, number, number, number, number][] = [[1, Q - 0.05, Q - 0.04, Q + 0.01, Q + 0.02]];
    for (let k = 0; k < 24; k++) {
      const a = (r() - 0.5) * 1.4, b = (r() - 0.5) * 1.4;
      paths.push([Math.floor(r() * 6), a, b, a + (r() - 0.5) * 0.04, b + (r() - 0.5) * 0.04]);
    }
    for (const [f, a0, b0, a1, b1] of paths) {
      const p = dirOf(f, a0, b0), q = dirOf(f, a1, b1);
      const H = (t: number): number => {
        const v = [0, 1, 2].map((k) => p[k] * (1 - t) + q[k] * t);
        const L = Math.hypot(v[0], v[1], v[2]);
        const d = v.map((x) => x / L);
        const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
        const face = ax >= ay && ax >= az ? (d[0] > 0 ? 0 : 2) : ay >= az ? (d[1] > 0 ? 1 : 3) : d[2] > 0 ? 4 : 5;
        const fa = new Float64Array(2);
        chartAngles(face, d[0], d[1], d[2], fa);
        return fn.sample(face, fa[0], fa[1], 2, out)[0];
      };
      const n = 1500;
      let worst = 0, at = 1, prev = H(0);
      for (let i = 1; i <= n; i++) {
        const h = H(i / n);
        if (Math.abs(h - prev) > worst) {
          worst = Math.abs(h - prev);
          at = i;
        }
        prev = h;
      }
      let fine = 0;
      prev = H((at - 1) / n);
      for (let i = 1; i <= 500; i++) {
        const h = H((at - 1 + i / 500) / n);
        fine = Math.max(fine, Math.abs(h - prev));
        prev = h;
      }
      expect(fine).toBeLessThan(0.05);
    }
  }, 30_000);

  it('equals the phase-3 bilinear globe at globe zoom', () => {
    const pg = prepared();
    const layer = { id: 'elevation', w: N, h: N, worldKm: (4 * CELL * N) / 1000, radiusKm: R / 1000, faces: 6, data: planet().elevation } as unknown as Layer;
    const hf = new GlobeHeightField(layer);
    // As the view wires it: the macro surface is the height field's padded water lid (the GPU's u_surf).
    const fn = new GlobeHeightFn({ n: N, radius: R, macroPad: pg.macroPad, surfacePad: hf.padded, control: pg.controlPad, params: pg.params, tiles: allTiles(pg.lattice) });
    const out = new Float64Array(4);
    for (const [f, a, b] of [[0, 0.1, 0.2], [3, -0.7, 0.5], [5, 0.78, -0.78]] as const) {
      expect(fn.surface(f, a, b, 10 * pg.params.texelM)).toBeCloseTo(hf.surfaceAt(f, a, b), 4);
      expect(fn.sample(f, a, b, 1e6, out)[0]).toBeCloseTo(fn.macroBilinear(f, a, b, new Float64Array(4))[0], 6);
    }
  });

  it('amplification never crosses the sea level, and its gradient matches finite differences', () => {
    const pg = prepared();
    const fn = heightFn(allTiles(pg.lattice));
    const r = rng(4);
    const flat = heightFn(allTiles(pg.lattice));
    flat.amp = 0;
    const out = new Float64Array(4);
    const base = new Float64Array(4);
    let land = 0;
    for (let k = 0; k < 400; k++) {
      const f = Math.floor(r() * 6);
      const a = (r() - 0.5) * 1.5, b = (r() - 0.5) * 1.5;
      const foot = 4;
      const h = fn.sample(f, a, b, foot, out)[0];
      const h0 = flat.sample(f, a, b, foot, base)[0];
      if (h0 > 0) land++;
      expect(Math.sign(h)).toBe(Math.sign(h0));
    }
    expect(land).toBeGreaterThan(50);
    // Gradient check on a land point.
    const f = 0, a = 0.11, b = -0.07, foot = 20;
    fn.sample(f, a, b, foot, out);
    const d = dirOf(f, a, b);
    const e = 1e-7;
    const fa = new Float64Array(2);
    for (const [k0, k1] of [[1, 0], [0, 1]]) {
      // Move along the chart axes and compare dh with g·dP.
      const p = dirOf(f, a + k0 * e, b + k1 * e);
      const m = dirOf(f, a - k0 * e, b - k1 * e);
      const hp = fn.sample(f, a + k0 * e, b + k1 * e, foot, base)[0];
      const hm = fn.sample(f, a - k0 * e, b - k1 * e, foot, base)[0];
      const dP = [0, 1, 2].map((c) => (p[c] - m[c]) * R);
      const pred = out[1] * dP[0] + out[2] * dP[1] + out[3] * dP[2];
      expect(Math.abs(hp - hm - pred)).toBeLessThan(0.02 * Math.abs(pred) + 1e-4);
      chartAngles(0, d[0], d[1], d[2], fa);
    }
  });

  it('detailed ground picking agrees with its own heights', () => {
    const pg = prepared();
    const fn = heightFn(allTiles(pg.lattice));
    const layer = { id: 'elevation', w: N, h: N, worldKm: (4 * CELL * N) / 1000, radiusKm: R / 1000, faces: 6, data: planet().elevation } as unknown as Layer;
    const hf = new GlobeHeightField(layer);
    const g = new GlobeDetailGround(fn, hf, 300);
    g.pxFoot = 20;
    const d = dirOf(0, 0.12, -0.05);
    const o = { x: d[0] * (R + 8000), y: d[1] * (R + 8000), z: d[2] * (R + 8000) };
    const ray = { x: -d[0] + 0.2, y: -d[1], z: -d[2] + 0.1 };
    const L = Math.hypot(ray.x, ray.y, ray.z);
    const hit = g.raycast(o, { x: ray.x / L, y: ray.y / L, z: ray.z / L })!;
    expect(hit).not.toBeNull();
    const r = Math.hypot(hit.x, hit.y, hit.z);
    expect(Math.abs(r - R - g.heightAtDir(hit.x, hit.y, hit.z))).toBeLessThan(0.05);
  });
});

describe('tile streaming and LRU', () => {
  const l = tileLattice(512, 652e3, 1024);
  const view = (dir: number[], alt: number, mpp = 20) => {
    const r = l.radius + alt;
    return { eye: { x: dir[0] * r, y: dir[1] * r, z: dir[2] * r }, pxScale: mpp / Math.max(1, alt), planes: null, maxHeight: 9000 };
  };

  it('wants nothing at globe zoom and the tile under a low camera first', () => {
    const c = new TileCache(l, 12);
    expect(c.plan(view(dirOf(0, 0.1, 0.1), 2e6, 4000))).toEqual([]);
    const d = dirOf(2, 0.3, -0.2);
    const w = c.plan(view(d, 3000, 10));
    expect(w[0]).toBe(tileAtDir(l, d[0], d[1], d[2]));
    expect(w.length).toBeLessThanOrEqual(12);
    // Every wanted tile is near: none on the far side of the planet.
    for (const key of w) expect(tileOfKey(key, l.T)[0] === 2 || c.tileView(key, view(d, 3000, 10)).dist < 300e3).toBe(true);
  });

  it('keeps wanted tiles and evicts the least recently wanted ones', () => {
    const c = new TileCache(l, 4);
    const fill = (d: number[]): number[] => {
      const w = c.plan(view(d, 20_000, 30));
      for (let k = c.next(); k >= 0; k = c.next()) {
        if (c.acquire(k) < 0) break;
        c.commit(k);
      }
      return w;
    };
    const w1 = fill(dirOf(0, 0, 0));
    expect(w1.length).toBeGreaterThan(0);
    for (const k of w1) expect(c.tile(k)).not.toBeNull();
    // Move across the planet: the old tiles are no longer wanted and get recycled.
    const w2 = fill(dirOf(4, 0.4, 0.4));
    for (const k of w2) expect(c.tile(k)).not.toBeNull();
    for (const k of w1) if (!w2.includes(k)) expect(c.slotOf.size <= 4).toBe(true);
    // A wanted tile is never evicted for another.
    const before = new Set(c.slotOf.keys());
    c.plan(view(dirOf(4, 0.4, 0.4), 20_000, 30));
    expect(c.acquire(tileKey(1, 0, 0, l.T))).toBe(-1);
    expect(new Set(c.slotOf.keys())).toEqual(before);
    // Fade-in runs over TILE_FADE_S and the index texture shows slot and fade.
    c.tick(0.2);
    const idx = new Float32Array(6 * l.T * l.T * 2);
    c.writeIndex(idx);
    const k0 = w2[0];
    expect(idx[k0 * 2]).toBe(c.slotOf.get(k0));
    expect(idx[k0 * 2 + 1]).toBeCloseTo(0.5, 5);
    c.tick(1);
    expect(c.tile(k0)!.fade).toBe(1);
  });
});
