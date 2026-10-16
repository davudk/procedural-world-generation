import { describe, expect, it } from 'vitest';
import { equirectLatLon, projectSphereLayer } from '../src/render/sphereProjection';
import { dirToCell, latLonDir } from '../src/shared/cube';
import type { Layer } from '../src/shared/protocol';

const n = 16;
const layer: Layer = {
  id: 'ids', label: 'Cell ids', stage: 'plates', kind: 'scalar', w: n, h: n, worldKm: 1024, unit: '', min: 0, max: 6 * n * n,
  data: Float32Array.from({ length: 6 * n * n }, (_, i) => i), faces: 6, radiusKm: 652,
};

describe('sphere projections', () => {
  it('the equirectangular map samples the cell under each latitude / longitude', () => {
    const m = projectSphereLayer(layer, 'equirect');
    expect(m.w).toBe(4 * n);
    expect(m.h).toBe(2 * n);
    expect(m.faces).toBeUndefined();
    expect(m.worldKm).toBe(4096);
    const d = new Float64Array(3);
    for (let y = 0; y < m.h; y += 3) {
      for (let x = 0; x < m.w; x += 5) {
        const xKm = ((x + 0.5) / m.w) * m.worldKm;
        const yKm = ((y + 0.5) / m.w) * m.worldKm;
        const [lat, lon] = equirectLatLon(m, xKm, yKm);
        latLonDir(lat, lon, d);
        expect(m.data[y * m.w + x]).toBe(dirToCell(d[0], d[1], d[2], n));
      }
    }
    // Cached per layer and projection.
    expect(projectSphereLayer(layer, 'equirect')).toBe(m);
  });

  it('the cube net lays the six faces out as a cross with NaN gaps', () => {
    const net = projectSphereLayer(layer, 'net');
    expect(net.w).toBe(4 * n);
    expect(net.h).toBe(3 * n);
    // Face 0 sits in column 1 of the middle row; face 4 (north) above it; the top-left block is empty.
    expect(net.data[n * net.w + n]).toBe(0);
    expect(net.data[n]).toBe(4 * n * n);
    expect(Number.isNaN(net.data[0])).toBe(true);
    let cells = 0;
    for (const v of net.data) if (!Number.isNaN(v)) cells++;
    expect(cells).toBe(6 * n * n);
  });
});
