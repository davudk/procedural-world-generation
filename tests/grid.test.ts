import { describe, expect, it } from 'vitest';
import { AXIAL_DX, AXIAL_DY, cellIndex, cellX, cellY, coarser, finer, flatGrid, RASTER_DX, RASTER_DY } from '../src/gen/grid/grid';

/** Brute-force neighbour k (raster order) of (x, y) on an n×n map, −1 off the map. */
function bruteNbr(n: number, x: number, y: number, k: number): number {
  const nx = x + RASTER_DX[k];
  const ny = y + RASTER_DY[k];
  return nx < 0 || ny < 0 || nx >= n || ny >= n ? -1 : ny * n + nx;
}

describe('flatGrid', () => {
  const n = 7;
  const g = flatGrid(n, 4, 'ocean');

  it('has one face of n² cells with the old cell-size constants', () => {
    expect(g.shape).toBe('flat');
    expect(g.faces).toBe(1);
    expect(g.cells).toBe(49);
    expect(g.cellKm).toBe(4);
    expect(g.cellM).toBe(4000);
    expect(g.uniform).toBe(true);
    expect(g.radiusM).toBe(Infinity);
    expect(g.totalArea).toBe(49 * 4000 * 4000);
    // Bit-exact against the expression the stages used before the Grid (cellKm = worldKm / n, cellM = cellKm · 1000).
    const worldKm = 1337;
    const h = flatGrid(1024, worldKm / 1024);
    expect(h.cellM).toBe((worldKm / 1024) * 1000);
    expect(h.dist(0, 0)).toBe(Math.SQRT2 * h.cellM);
    expect(h.dist(0, 1)).toBe(h.cellM);
    expect(h.area(5)).toBe(h.cellM * h.cellM);
  });

  it('nbr matches the raster D8 table everywhere, and off8 inside', () => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        for (let k = 0; k < 8; k++) {
          const want = bruteNbr(n, x, y, k);
          expect(g.nbr(i, k)).toBe(want);
          if (!g.border[i]) expect(i + g.off8[k]).toBe(want);
        }
      }
    }
  });

  it('axial offsets map onto raster k, and off4 are the axial four', () => {
    for (let k = 0; k < 8; k++) {
      const r = g.axialToRaster[k];
      expect(RASTER_DX[r]).toBe(AXIAL_DX[k]);
      expect(RASTER_DY[r]).toBe(AXIAL_DY[k]);
      expect(g.off8Axial[k]).toBe(g.off8[r]);
    }
    expect([...g.off4]).toEqual([1, -1, n, -n]);
  });

  it('border is exactly the cells with an off-map neighbour (4n − 4 of them)', () => {
    let count = 0;
    for (let i = 0; i < g.cells; i++) {
      let off = false;
      for (let k = 0; k < 8; k++) off ||= g.nbr(i, k) < 0;
      expect(g.border[i]).toBe(off ? 1 : 0);
      count += g.border[i];
    }
    expect(count).toBe(4 * n - 4);
    expect(g.borderSlot).toBeNull();
    expect(g.seam).toBeNull();
  });

  it('neighbourhood is symmetric', () => {
    for (let i = 0; i < g.cells; i++) {
      for (let k = 0; k < 8; k++) {
        const j = g.nbr(i, k);
        if (j >= 0) expect(g.nbr(j, 7 - k)).toBe(i);
      }
    }
  });

  it('outlets are the map edge only when the map edge is continent', () => {
    expect(g.outlets).toBeNull();
    expect(g.mapEdge).toBe('ocean');
    const c = flatGrid(n, 4, 'continent');
    expect(c.outlets).not.toBeNull();
    expect([...c.outlets!]).toEqual([...c.border]);
    expect(c.hasOutside).toBe(true);
  });

  it('positions, points, locate and distance agree', () => {
    const pos = new Float64Array(3);
    for (let i = 0; i < g.cells; i++) {
      const p = g.point(i);
      g.position(i, pos);
      expect(p.face).toBe(0);
      expect(p.u).toBe((cellX(g, i) + 0.5) * g.cellM);
      expect(p.v).toBe((cellY(g, i) + 0.5) * g.cellM);
      expect([pos[0], pos[1], pos[2]]).toEqual([p.u, p.v, 0]);
      expect(g.locate(p)).toBe(i);
      expect(cellIndex(g, cellX(g, i), cellY(g, i))).toBe(i);
    }
    expect(g.locate({ face: 0, u: -5, v: 1e9 })).toBe(cellIndex(g, 0, n - 1));
    expect(g.distance(0, cellIndex(g, 3, 4))).toBeCloseTo(5 * g.cellM, 9);
    const east = new Float64Array(3);
    const north = new Float64Array(3);
    const up = new Float64Array(3);
    g.frame(0, east, north, up);
    expect([...east, ...north, ...up]).toEqual([1, 0, 0, 0, -1, 0, 0, 0, 1]);
  });

  it('chart visits the disk with east/north offsets (north = −y)', () => {
    const c = g.point(cellIndex(g, 3, 3));
    const seen: [number, number, number][] = [];
    g.chart(c, 1.5 * g.cellM, (i, e, nn) => seen.push([i, e, nn]));
    // 3×3 block around the centre (corners at √2 cells < 1.5).
    expect(seen.length).toBe(9);
    expect(seen[0]).toEqual([cellIndex(g, 2, 2), -g.cellM, g.cellM]);
    for (const [i, e, nn] of seen) expect(Math.hypot(e, nn)).toBeLessThanOrEqual(1.5 * g.cellM);
  });

  it('sample interpolates bilinearly between cell centres and clamps at the edges', () => {
    const f = new Float32Array(g.cells);
    for (let i = 0; i < g.cells; i++) f[i] = 2 * cellX(g, i) + 3 * cellY(g, i);
    expect(g.sample(f, { face: 0, u: 2 * g.cellM, v: 3 * g.cellM })).toBeCloseTo(2 * 1.5 + 3 * 2.5, 6);
    expect(g.sample(f, { face: 0, u: -1e6, v: -1e6 })).toBe(0);
  });

  it('coarser and finer keep the world size and are cached', () => {
    const big = flatGrid(64, 2, 'continent');
    const c = coarser(big, 4);
    expect(c.n).toBe(16);
    expect(c.cellKm).toBe(8);
    expect(c.mapEdge).toBe('continent');
    expect(coarser(big, 4)).toBe(c);
    expect(coarser(big, 1)).toBe(big);
    expect(finer(c, 4).cellM).toBe(big.cellM);
    expect(() => coarser(big, 3)).toThrow();
  });
});
