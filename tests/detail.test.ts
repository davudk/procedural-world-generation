import { describe, expect, it } from 'vitest';
import { DETAIL_GLSL, NOISE_GLSL } from '../src/render/glsl/detail';
import {
  DN, HeightFn, bicubicQ, detailParams, fbm, footWeight, hashU, hashV, noised, waterBounds, type HeightSources,
} from '../src/render/height/heightFn';
import { DETAIL_BUILD_SOURCES, buildDetailCpu, prepareDetail, type DetailInput, type PreparedDetail } from '../src/render/terrain/detail/detailMap';
import type { Layer, RiverGraph } from '../src/shared/protocol';

// ---- Reference implementation of the GLSL noise: float32 arithmetic, BigInt hash ---------------

const F = Math.fround;
const M32 = (1n << 32n) - 1n;
const mulU = (a: bigint, b: number): bigint => (a * BigInt(b >>> 0)) & M32;

function refHash(ix: number, iy: number, seed: number): number {
  const ux = BigInt(ix >>> 0);
  const uy = BigInt(iy >>> 0);
  let h = mulU(ux, DN.M1) ^ mulU(uy, DN.M2) ^ mulU(BigInt(seed >>> 0), DN.M3);
  h ^= h >> 16n;
  h = mulU(h, DN.F1);
  h ^= h >> 15n;
  h = mulU(h, DN.F2);
  h ^= h >> 16n;
  return Number(h);
}

/** Line-by-line float32 port of GLSL dnNoise. */
function refNoise(wx: number, wy: number, lam: number, seed: number): [number, number, number] {
  const w = [F(wx), F(wy)];
  const out: number[] = [];
  const t = w.map((v) => Math.floor(F(v * F(1 / DN.TILE))));
  const q = w.map((v, k) => F(F(v - F(t[k] * DN.TILE)) / lam));
  const fq = q.map(Math.floor);
  const f = q.map((v, k) => F(v - fq[k]));
  const i = t.map((v, k) => (v + DN.TILE_BIAS) * (DN.TILE / lam) + fq[k]);
  const u = f.map((x) => F(F(F(x * x) * x) * F(F(x * F(F(x * 6) - 15)) + 10)));
  const du = f.map((x) => F(F(F(30 * x) * x) * F(F(x * F(x - 2)) + 1)));
  const val = (a: number, b: number): number => F((refHash(a, b, seed) >>> 8) * (2 / 16777216) - 1);
  const a = val(i[0], i[1]);
  const b = val(i[0] + 1, i[1]);
  const c = val(i[0], i[1] + 1);
  const d = val(i[0] + 1, i[1] + 1);
  const k1 = F(b - a);
  const k2 = F(c - a);
  const k4 = F(F(F(a - b) - c) + d);
  out.push(F(F(F(a + F(k1 * u[0])) + F(k2 * u[1])) + F(F(k4 * u[0]) * u[1])));
  out.push(F(F(du[0] * F(k1 + F(k4 * u[1]))) / lam));
  out.push(F(F(du[1] * F(k2 + F(k4 * u[0]))) / lam));
  return out as [number, number, number];
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- Synthetic world: a ridge sloping to a lake, a river from the ridge into the lake -----------

const N = 64;
const SIZE = 64_000;
const CELL = SIZE / N;
const LAKE = { x: 44, y: 40, r: 9, level: 120 };

function layer(id: string, data: Float32Array | Uint8Array): Layer {
  return { id, label: id, stage: 'hydro', kind: 'scalar', w: N, h: N, worldKm: SIZE / 1000, unit: '', min: 0, max: 1, data } as Layer;
}

function world(): DetailInput {
  const elev = new Float32Array(N * N);
  const wl = new Float32Array(N * N).fill(-10000);
  const cls = new Uint8Array(N * N);
  const biome = new Uint8Array(N * N).fill(6);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const d = Math.hypot(x - LAKE.x, y - LAKE.y);
      elev[i] = 80 + 18 * d + 600 * Math.exp(-(((x - 12) / 6) ** 2)) + 40 * Math.sin(x * 0.7) * Math.cos(y * 0.5);
      if (d < LAKE.r) {
        elev[i] = Math.min(elev[i], LAKE.level - 0.5 - (LAKE.r - d) * 4);
        wl[i] = LAKE.level;
        cls[i] = 2;
      }
      if (x > 20 && x < 30 && y < 15) biome[i] = 10; // a small hot desert
    }
  }
  // River: straight from (8 km, 40 km map) to the lake shore, zWater falling 700 → 120.
  const nodes = 30;
  const g: RiverGraph = {
    n: nodes,
    x: new Float32Array(nodes),
    y: new Float32Array(nodes),
    zWater: new Float32Array(nodes),
    zBed: new Float32Array(nodes),
    q: new Float32Array(nodes).fill(10),
    area: new Float32Array(nodes).fill(500),
    width: new Float32Array(nodes).fill(30),
    depth: new Float32Array(nodes).fill(2),
    strahler: new Uint8Array(nodes).fill(3),
    down: new Int32Array(nodes),
    flags: new Uint16Array(nodes),
    reachStart: Uint32Array.of(0),
    reachLen: Uint32Array.of(nodes),
    reachDown: Int32Array.of(-1),
    reachMinArea: Float32Array.of(500),
  };
  const x0 = 8_000;
  const x1 = (LAKE.x - LAKE.r + 1) * CELL;
  const yMap = (LAKE.y + 0.5) * CELL;
  for (let k = 0; k < nodes; k++) {
    const t = k / (nodes - 1);
    g.x[k] = x0 + (x1 - x0) * t;
    g.y[k] = yMap;
    g.zWater[k] = 700 + (LAKE.level - 700) * t;
    g.zBed[k] = g.zWater[k] - 2;
    g.down[k] = k + 1 < nodes ? k + 1 : -1;
    // Macro carve along the river (as hydrology does).
    const cx = Math.min(N - 1, Math.floor(g.x[k] / CELL));
    const cy = Math.floor(yMap / CELL);
    elev[cy * N + cx] = Math.min(elev[cy * N + cx], g.zBed[k]);
  }
  return {
    elevation: layer('elevation', elev),
    waterLevel: layer('waterLevel', wl),
    waterClass: layer('waterClass', cls),
    discharge: null,
    biome: layer('biome', biome),
    rivers: g,
    seed: 1234,
    size: 2048,
  };
}

function run<T>(gen: Generator<number, T>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

const D = 256; // 250 m texels over the 64 km test world
let cache: { prep: PreparedDetail; det: Float32Array } | null = null;
function built(): { prep: PreparedDetail; det: Float32Array } {
  if (!cache) {
    const prep = run(prepareDetail(world(), D));
    const det = run(buildDetailCpu(prep, 4, { talus: 0.75, thermalRate: 0.5 }));
    cache = { prep, det };
  }
  return cache;
}

function sources(over: Partial<HeightSources> = {}): HeightSources {
  const { prep, det } = built();
  return {
    size: prep.size, macro: prep.macro, macroN: prep.n, water: prep.water, params: prep.params,
    detail: det, control: prep.control, controlN: prep.controlN, ...over,
  };
}

// ---- Tests --------------------------------------------------------------------------------------

describe('detail noise (TS ↔ GLSL reference)', () => {
  it('integer hash matches a BigInt reference bit for bit', () => {
    const r = rng(7);
    for (let k = 0; k < 2000; k++) {
      const ix = Math.floor(r() * 2 ** 21);
      const iy = Math.floor(r() * 2 ** 21);
      const s = Math.floor(r() * 2 ** 32);
      expect(hashU(ix, iy, s)).toBe(refHash(ix, iy, s));
    }
    expect(hashV(0, 0, 0)).toBeGreaterThanOrEqual(-1);
  });

  it('TS noise matches the float32 GLSL reference, including at the far corner of a 4096 km world', () => {
    const r = rng(11);
    const out = new Float64Array(3);
    for (const extent of [10_000, 1_024_000, 4_096_000]) {
      for (let k = 0; k < 500; k++) {
        const x = r() * extent;
        const y = r() * extent;
        const lam = 2 ** (4 + Math.floor(r() * 9));
        const seed = Math.floor(r() * 2 ** 32);
        // Evaluate the TS version at the float32-rounded point the GPU would see.
        noised(F(x), F(y), lam, lam, seed, out);
        const ref = refNoise(x, y, lam, seed);
        expect(Math.abs(out[0] - ref[0])).toBeLessThan(2e-5);
        expect(Math.abs(out[1] - ref[1]) * lam).toBeLessThan(5e-4);
        expect(Math.abs(out[2] - ref[2]) * lam).toBeLessThan(5e-4);
      }
    }
  });

  it('noise is smooth (not blocky) at 4096 km: the lattice fraction keeps full precision', () => {
    const out = new Float64Array(3);
    const a = refNoise(4_095_000.5, 4_093_000.5, 16, 3);
    const b = refNoise(4_095_001.0, 4_093_000.5, 16, 3);
    noised(4_095_000.5, 4_093_000.5, 16, 16, 3, out);
    // Finite difference over 0.5 m agrees with the analytic derivative.
    expect(Math.abs((b[0] - a[0]) / 0.5 - out[1])).toBeLessThan(0.02);
  });

  it('GLSL is generated from the shared constants', () => {
    for (const c of [DN.M1, DN.M2, DN.M3, DN.F1, DN.F2, DN.OCT]) expect(NOISE_GLSL).toContain(`0x${c.toString(16)}u`);
    expect(NOISE_GLSL).toContain(`DN_DAMP = ${DN.DAMP.toFixed(1)}`);
    expect(DETAIL_GLSL).toContain('float terrainHeight(vec2 w, float pxFoot)');
    expect(DETAIL_GLSL).toContain('float terrainSurface(vec2 w, float pxFoot)');
    expect(DETAIL_GLSL).toContain('vec2 terrainGradient(vec2 w, float pxFoot)');
    for (const [vs, fs] of Object.values(DETAIL_BUILD_SOURCES)) {
      expect(vs.startsWith('#version 300 es')).toBe(true);
      expect(fs.startsWith('#version 300 es')).toBe(true);
      expect(fs).not.toMatch(/\bhalf\b/); // reserved word in GLSL ES
    }
  });
});

describe('footprint fading', () => {
  it('octave weights fall monotonically from 1 (λ ≥ 4 px) to 0 (λ ≤ 2 px)', () => {
    let prev = 1;
    for (let px = 0.1; px < 100; px *= 1.05) {
      const w = footWeight(px, 64);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    expect(footWeight(16, 64)).toBe(1);
    expect(footWeight(32, 64)).toBe(0);
  });

  it('amplification energy decreases monotonically with footprint; none at world zoom', () => {
    const p = detailParams(1_024_000, 4096, 1024, 9);
    const r = rng(5);
    const pts = Array.from({ length: 300 }, () => [r() * 1e6, r() * 1e6]);
    const out = new Float64Array(3);
    let prev = Infinity;
    for (let px = 2; px < 1000; px *= 1.25) {
      let e = 0;
      for (const [x, y] of pts) {
        out.fill(0);
        fbm(x, y, px, p.lam0, p.octaves, 50, 0.3, 0, 0, p.seed, out);
        e += out[0] * out[0];
      }
      expect(e).toBeLessThanOrEqual(prev * 1.02 + 1e-12);
      prev = e;
    }
    expect(prev).toBe(0);
    const fn = new HeightFn(sources());
    let w = 1;
    for (let px = 1; px < 5000; px *= 1.3) {
      const t = fn.detailWeight(px);
      expect(t).toBeLessThanOrEqual(w);
      w = t;
    }
    expect(w).toBe(0);
  });
});

describe('height function', () => {
  it('bicubic reproduces the macro at cell centres (and the detail map at its texel centres)', () => {
    const { prep, det } = built();
    const fn = new HeightFn(sources({ detail: null }));
    for (let y = 0; y < N; y += 3) {
      for (let x = 0; x < N; x += 3) {
        const wx = (x + 0.5) * CELL;
        const wy = SIZE - (y + 0.5) * CELL;
        expect(fn.macroBicubic(wx, wy)[0]).toBeCloseTo(prep.macro[y * N + x], 3);
      }
    }
    const t = SIZE / D;
    const out = new Float64Array(5);
    for (let k = 0; k < 200; k++) {
      const x = (k * 37) % D;
      const y = (k * 91) % D;
      bicubicQ(det, D, x, y, out);
      expect(out[0]).toBeCloseTo(det[y * D + x], 3);
    }
    // At a detail texel centre, with amplification off, the height function returns the stored texel.
    const fd = new HeightFn(sources());
    fd.amp = 0;
    expect(fd.terrainHeight((10 + 0.5) * t, SIZE - (20 + 0.5) * t, 20)).toBeCloseTo(det[20 * D + 10], 3);
  });

  it('without detail it equals the bilinear macro (= GLSL rawHeight / surfaceHeight)', () => {
    const { prep } = built();
    const fn = new HeightFn(sources({ params: null }));
    const x = 13.25 * CELL;
    const y = SIZE - 30.75 * CELL;
    const a = prep.macro[30 * N + 12];
    const b = prep.macro[30 * N + 13];
    const c = prep.macro[31 * N + 12];
    const d = prep.macro[31 * N + 13];
    const ab = a + (b - a) * 0.75;
    const cd = c + (d - c) * 0.75;
    expect(fn.terrainHeight(x, y, 5)).toBeCloseTo(ab + (cd - ab) * 0.25, 4);
  });

  it('amplification is zero where the control marks water/channels, and never crosses the water level', () => {
    const { prep } = built();
    const ctlWater = prep.control.slice();
    for (let i = 2; i < ctlWater.length; i += 4) ctlWater[i] = 255;
    const a = new HeightFn(sources({ control: ctlWater }));
    const b = new HeightFn(sources({ control: ctlWater }));
    b.amp = 0;
    const r = rng(3);
    for (let k = 0; k < 300; k++) {
      const x = r() * SIZE;
      const y = r() * SIZE;
      expect(a.terrainHeight(x, y, 8)).toBe(b.terrainHeight(x, y, 8));
    }
    // With the real control: amplification is active on dry slopes but keeps the land/water sign.
    const fa = new HeightFn(sources());
    const f0 = new HeightFn(sources());
    f0.amp = 0;
    let changed = 0;
    for (let k = 0; k < 4000; k++) {
      const x = r() * SIZE;
      const y = r() * SIZE;
      const h = fa.terrainHeight(x, y, 8);
      const h0 = f0.terrainHeight(x, y, 8);
      if (Math.abs(h - h0) > 0.5) changed++;
      const wl = fa.waterLevelAt(x, y);
      if (wl > DN.DRY) expect(Math.sign(h - wl)).toBe(Math.sign(h0 - wl));
    }
    expect(changed).toBeGreaterThan(400);
  });

  it('gradient matches finite differences of the height', () => {
    const fn = new HeightFn(sources());
    const r = rng(21);
    let ok = 0;
    for (let k = 0; k < 200; k++) {
      const x = 2000 + r() * (SIZE - 4000);
      const y = 2000 + r() * (SIZE - 4000);
      const e = 0.05;
      const [gx, gy] = fn.terrainGradient(x, y, 30);
      const fx = (fn.terrainHeight(x + e, y, 30) - fn.terrainHeight(x - e, y, 30)) / (2 * e);
      const fy = (fn.terrainHeight(x, y + e, 30) - fn.terrainHeight(x, y - e, 30)) / (2 * e);
      // The damping factor and amplitude caps are treated as constant, so allow a loose match.
      if (Math.hypot(gx - fx, gy - fy) < 0.05 + 0.25 * Math.hypot(fx, fy)) ok++;
    }
    expect(ok).toBeGreaterThan(180);
  });

  it('lake surfaces stay flat: the lid is the lake level wherever the macro is lake', () => {
    const fn = new HeightFn(sources());
    for (let k = -5; k <= 5; k++) {
      const x = (LAKE.x + 0.5 + k * 0.6) * CELL;
      const y = SIZE - (LAKE.y + 0.5 + k * 0.3) * CELL;
      expect(fn.terrainSurface(x, y, 8)).toBeCloseTo(LAKE.level, 4);
      expect(fn.terrainHeight(x, y, 8)).toBeLessThan(LAKE.level - 0.4);
    }
  });

  it('is deterministic, and the seed changes the detail', () => {
    const a = run(buildDetailCpu(run(prepareDetail(world(), 128)), 2, { talus: 0.75, thermalRate: 0.5 }));
    const b = run(buildDetailCpu(run(prepareDetail(world(), 128)), 2, { talus: 0.75, thermalRate: 0.5 }));
    expect(a).toEqual(b);
    const w2 = { ...world(), seed: 99 };
    const c = run(buildDetailCpu(run(prepareDetail(w2, 128)), 2, { talus: 0.75, thermalRate: 0.5 }));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - c[i]));
    expect(diff).toBeGreaterThan(1);
    const f1 = new HeightFn(sources());
    const f2 = new HeightFn(sources());
    expect(f1.terrainHeight(31_234, 17_890, 9)).toBe(f2.terrainHeight(31_234, 17_890, 9));
  });
});

describe('detail map build (CPU reference of the GPU passes)', () => {
  it('respects the macro water: water stays below its level, dry land above it', () => {
    const { prep, det } = built();
    const t = SIZE / D;
    const tmp = new Float64Array(3);
    let water = 0;
    let shore = 0;
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        const qx = ((x + 0.5) * t) / CELL - 0.5;
        const qy = ((y + 0.5) * t) / CELL - 0.5;
        const ix = Math.floor(qx);
        const iy = Math.floor(qy);
        const bil = (d: Float32Array): number => {
          const fx = qx - ix;
          const fy = qy - iy;
          const g = (i: number, j: number): number => d[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
          const ab = g(ix, iy) + (g(ix + 1, iy) - g(ix, iy)) * fx;
          const cd = g(ix, iy + 1) + (g(ix + 1, iy + 1) - g(ix, iy + 1)) * fx;
          return ab + (cd - ab) * fy;
        };
        const hb = bil(prep.macro);
        const wl = bil(prep.water!);
        const [lo, hi] = waterBounds(hb, wl);
        const h = det[y * D + x];
        expect(h).toBeLessThanOrEqual(hi);
        if (hi < 1e29) water++;
        // Dry land may only go below `lo` inside a river channel (carved below the water surface).
        if (lo > -1e29 && h < lo) {
          const my = (y + 0.5) * t;
          expect(Math.abs(my - (LAKE.y + 0.5) * CELL)).toBeLessThan(30);
        }
        if (lo > -1e29 && wl > DN.DRY) shore++;
        void tmp;
      }
    }
    expect(water).toBeGreaterThan(500);
    expect(shore).toBeGreaterThan(500);
  });

  it('river channel is carved: the centreline never rises above the water surface', () => {
    const { prep } = built();
    const fn = new HeightFn(sources());
    const g = world().rivers!;
    let maxAbove = -Infinity;
    for (let k = 0; k < g.n - 1; k++) {
      for (let s = 0; s < 4; s++) {
        const t = s / 4;
        const mx = g.x[k] + (g.x[k + 1] - g.x[k]) * t;
        const my = g.y[k] + (g.y[k + 1] - g.y[k]) * t;
        const zw = g.zWater[k] + (g.zWater[k + 1] - g.zWater[k]) * t;
        const h = fn.terrainHeight(mx, prep.size - my, 8);
        // The channel holds the river surface everywhere (min() of profiles with zb ≤ zw non-increasing
        // downstream), so the ribbon is never buried; amplification is suppressed along channels.
        expect(h).toBeLessThanOrEqual(zw + 0.5);
        maxAbove = Math.max(maxAbove, h - zw);
      }
    }
    expect(maxAbove).toBeLessThan(0.5);
  });

  it('control texture marks water and channels, rock on steep slopes, dunes in the desert', () => {
    const { prep } = built();
    const cn = prep.controlN;
    const at = (mx: number, my: number, c: number): number =>
      prep.control[(Math.min(cn - 1, Math.floor((my / SIZE) * cn)) * cn + Math.min(cn - 1, Math.floor((mx / SIZE) * cn))) * 4 + c];
    expect(at((LAKE.x + 0.5) * CELL, (LAKE.y + 0.5) * CELL, 2)).toBe(255);
    expect(at(16_000, (LAKE.y + 0.5) * CELL, 2)).toBeGreaterThan(200);
    expect(at(25 * CELL, 8 * CELL, 3)).toBeGreaterThan(50);
    expect(at(25 * CELL, 50 * CELL, 3)).toBe(0);
  });
});
