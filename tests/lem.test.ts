import { describe, expect, it } from 'vitest';
import { priorityFloodEpsilon } from '../src/gen/grid/priorityFlood';
import { downsampleMean, upsampleBicubic } from '../src/gen/grid/upsample';
import { DEFAULT_LEM_PARAMS, FlowRouter, LAND_MIN, runLem, upliftForPeak, type LemInput, type LemParams } from '../src/gen/lem/streamPower';
import { hashBytes } from '../src/shared/hash';
import { Rng } from '../src/shared/rng';

const CELL = 2000;
const K0 = 1e-5;

/** Square island: ocean ring outside radius 0.42·n (fixed at −1000 m), low random land inside. */
function island(n: number, seed: number, U0 = 1e-3): LemInput {
  const N = n * n;
  const rng = new Rng(seed);
  const h = new Float32Array(N);
  const fixed = new Uint8Array(N);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const r = Math.hypot(x - c, y - c) / n;
      if (r > 0.42) {
        fixed[i] = 1;
        h[i] = -1000;
      } else {
        h[i] = 1 + 200 * (0.42 - r) + 20 * rng.float();
      }
    }
  }
  return { n, cellM: CELL, h, U: new Float32Array(N).fill(U0), K: new Float32Array(N).fill(K0), fixed };
}

/** Strip draining to base level at x = 0 and x = n−1; top and bottom rows are closed map edges. */
function strip(n: number, seed: number, U0: number): LemInput {
  const N = n * n;
  const rng = new Rng(seed);
  const h = new Float32Array(N);
  const fixed = new Uint8Array(N);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (x === 0 || x === n - 1) fixed[i] = 1;
      else h[i] = 1 + 10 * rng.float();
    }
  }
  return { n, cellM: CELL, h, U: new Float32Array(N).fill(U0), K: new Float32Array(N).fill(K0), fixed };
}

const params = (over: Partial<LemParams> = {}): LemParams => ({ ...DEFAULT_LEM_PARAMS, ...over });

function neighbours(n: number, i: number): number[] {
  const x = i % n;
  const y = (i - x) / n;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < n && ny < n) out.push(ny * n + nx);
    }
  }
  return out;
}

describe('priorityFloodEpsilon', () => {
  it('drains every non-seed cell along a strictly descending path and never lowers', () => {
    const n = 64;
    const rng = new Rng(3);
    const h = new Float32Array(n * n);
    const seed = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const x = i % n;
      const y = (i - x) / n;
      // Rough pit-riddled surface at large elevations so the float32 ε scaling matters.
      h[i] = 3000 + 500 * rng.float() + 200 * Math.sin(x * 0.3) * Math.cos(y * 0.25);
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1) seed[i] = 1;
    }
    for (let i = 1000; i < 1300; i++) h[i] = 3100; // a large flat
    const out = new Float32Array(n * n);
    priorityFloodEpsilon(h, n, seed, out, 1e-4);
    let raised = 0;
    for (let i = 0; i < n * n; i++) {
      if (seed[i]) {
        expect(out[i]).toBe(h[i]);
        continue;
      }
      expect(out[i]).toBeGreaterThanOrEqual(h[i]);
      if (out[i] > h[i]) raised++;
      expect(neighbours(n, i).some((j) => out[j] < out[i])).toBe(true);
    }
    expect(raised).toBeGreaterThan(50);
  });
});

describe('upsample', () => {
  it('reproduces linear ramps in the interior and round-trips the mean', () => {
    const n = 16;
    const src = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) src[i] = 3 * (i % n) + 2 * Math.floor(i / n);
    const up = upsampleBicubic(src, n, 2);
    const m = 2 * n;
    for (let Y = 4; Y < m - 4; Y++) {
      for (let X = 4; X < m - 4; X++) expect(up[Y * m + X]).toBeCloseTo(3 * ((X + 0.5) / 2 - 0.5) + 2 * ((Y + 0.5) / 2 - 0.5), 4);
    }
    const back = downsampleMean(up, m, 2);
    for (let Y = 2; Y < n - 2; Y++) for (let X = 2; X < n - 2; X++) expect(back[Y * n + X]).toBeCloseTo(src[Y * n + X], 4);
  });
});

describe('FlowRouter', () => {
  it('orders receivers before donors and conserves rain-weighted area', () => {
    const inp = island(96, 5);
    const rain = new Float32Array(96 * 96);
    const rng = new Rng(9);
    for (let i = 0; i < rain.length; i++) rain[i] = 0.5 + rng.float();
    const r = new FlowRouter(inp.n, CELL, inp.fixed);
    r.route(inp.h, new Rng(1), rain);
    const pos = new Int32Array(inp.h.length).fill(-1);
    for (let k = 0; k < r.stackLen; k++) pos[r.stack[k]] = k;
    let landArea = 0;
    let outletArea = 0;
    for (let i = 0; i < inp.h.length; i++) {
      if (inp.fixed[i]) {
        expect(r.rcv[i]).toBe(i);
        outletArea += r.area[i];
        continue;
      }
      landArea += CELL * CELL * rain[i];
      expect(pos[i]).toBeGreaterThanOrEqual(0);
      expect(pos[r.rcv[i]]).toBeLessThan(pos[i]);
      expect(r.filled[r.rcv[i]]).toBeLessThan(r.filled[i]);
    }
    expect(outletArea / landArea).toBeCloseTo(1, 9);
  });
});

describe('runLem', () => {
  it('is deterministic, keeps fixed cells untouched and land above sea level', async () => {
    const run = async (seed: number) => {
      const inp = island(64, 11);
      const before = inp.h.slice();
      const res = await runLem(inp, params({ iterations: 20, stochasticIterations: 10, diffusionOffLast: 4 }), new Rng(seed));
      return { inp, before, res };
    };
    const a = await run(1);
    const b = await run(1);
    const c = await run(2);
    expect(hashBytes(a.res.h)).toBe(hashBytes(b.res.h));
    expect(hashBytes(a.res.area)).toBe(hashBytes(b.res.area));
    expect(hashBytes(a.res.h)).not.toBe(hashBytes(c.res.h));
    let maxH = 0;
    for (let i = 0; i < a.res.h.length; i++) {
      if (a.inp.fixed[i]) expect(a.res.h[i]).toBe(a.before[i]);
      else {
        expect(a.res.h[i]).toBeGreaterThanOrEqual(LAND_MIN);
        maxH = Math.max(maxH, a.res.h[i]);
      }
    }
    expect(maxH).toBeGreaterThan(500);
  });

  it('propagates checkpoint cancellation', async () => {
    const inp = island(32, 1);
    const cancel = async (): Promise<void> => {
      throw new Error('cancelled');
    };
    await expect(runLem(inp, params({ iterations: 10 }), new Rng(1), cancel)).rejects.toThrow('cancelled');
  });

  it('reaches the steady-state relief predicted by upliftForPeak', async () => {
    const n = 96;
    const target = 3000;
    const halfWidth = ((n - 1) / 2) * CELL;
    const U0 = upliftForPeak(target, K0, 0.4, halfWidth, CELL);
    const inp = strip(n, 4, U0);
    const relief: number[] = [];
    const res = await runLem(inp, params({ iterations: 160 }), new Rng(4), undefined, (_i, h) => {
      let mx = 0;
      for (let i = 0; i < h.length; i++) if (h[i] > mx) mx = h[i];
      relief.push(mx);
    });
    const final = relief[relief.length - 1];
    const ratio = final / target;
    // Network reorganisation keeps the peak wandering a few %; compare before diffusion switches off.
    const drift = relief[relief.length - 21] / relief[relief.length - 41] - 1;
    console.log(`[lem] calibration: U=${(U0 * 1e3).toFixed(3)} mm/yr, relief ${final.toFixed(0)} m vs target ${target} m → ratio ${ratio.toFixed(3)}; drift ${(drift).toFixed(4)}; ${res.ms.toFixed(0)} ms`);
    expect(Math.abs(drift)).toBeLessThan(0.1);
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it('grows a dendritic network (Hack exponent of the main stem)', async () => {
    const n = 256;
    const inp = island(n, 22);
    const res = await runLem(inp, params({ iterations: 80 }), new Rng(22));
    const N = n * n;
    const { area, rcv } = res;
    // Longest upstream flow length: donors have strictly smaller area than their receiver.
    const order = Array.from({ length: N }, (_, i) => i).filter((i) => !inp.fixed[i]);
    order.sort((a, b) => area[a] - area[b] || a - b);
    const len = new Float64Array(N);
    for (const i of order) {
      const r = rcv[i];
      const x = i % n;
      const d = x !== r % n && Math.floor(i / n) !== Math.floor(r / n) ? Math.SQRT2 * CELL : CELL;
      len[r] = Math.max(len[r], len[i] + d);
    }
    let mouth = order[order.length - 1];
    const pts: [number, number][] = [];
    for (;;) {
      if (area[mouth] < 20 * CELL * CELL) break;
      pts.push([Math.log(area[mouth]), Math.log(len[mouth] + CELL)]);
      let next = -1;
      for (const j of neighbours(n, mouth)) if (rcv[j] === mouth && (next < 0 || area[j] > area[next])) next = j;
      if (next < 0) break;
      mouth = next;
    }
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const hack = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    console.log(`[lem] Hack exponent ${hack.toFixed(3)} over ${pts.length} main-stem cells; 256²×80 in ${res.ms.toFixed(0)} ms`);
    expect(hack).toBeGreaterThan(0.45);
    expect(hack).toBeLessThan(0.7);
  });

  it('times 80 iterations at 512²', async () => {
    const inp = island(512, 7);
    const res = await runLem(inp, params({ iterations: 80 }), new Rng(7));
    const per = Object.entries(res.profile)
      .map(([k, v]) => `${k} ${(v / res.iterations).toFixed(2)}`)
      .join(', ');
    console.log(`[lem] 512²×80: ${res.ms.toFixed(0)} ms total; per iteration ms: ${per}`);
    expect(res.ms).toBeGreaterThan(0);
  }, 60_000);
});

describe('diffusion stability', () => {
  it('leaves no cell-parity checkerboard at 1 km cells (c = kd·dt/cell² at the classic 1/4 limit)', async () => {
    const inp = { ...island(96, 5), cellM: 1000 };
    const res = await runLem(inp, params({ iterations: 40, stochasticIterations: 0, diffusionOffLast: 0, talus: 10 }), new Rng(5));
    const { h, n } = { h: res.h, n: inp.n };
    // A checkerboard makes the orthogonal-neighbour Laplacian dominate the diagonal one.
    let orth = 0;
    let diag = 0;
    for (let y = 2; y < n - 2; y++) {
      for (let x = 2; x < n - 2; x++) {
        const i = y * n + x;
        if (inp.fixed[i]) continue;
        orth += Math.abs(h[i] - (h[i - 1] + h[i + 1] + h[i - n] + h[i + n]) / 4);
        diag += Math.abs(h[i] - (h[i - 1 - n] + h[i + 1 - n] + h[i - 1 + n] + h[i + 1 + n]) / 4);
      }
    }
    expect(orth).toBeLessThan(diag);
  });
});
