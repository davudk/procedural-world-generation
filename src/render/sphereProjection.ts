import { dirToFaceXY } from '../shared/cube';
import type { Layer } from '../shared/protocol';

/**
 * Flat projections of cube-sphere layers for the 2D viewer (research 10 §6.8), computed on the main
 * thread: an equirectangular map (4n × 2n, longitude −180°…180° left to right, north up) and a cube
 * net (a cross of the six faces, 4n × 3n, for looking at the raw faces and seams). Cells outside the
 * net are NaN, which the raster view leaves as background. The results are ordinary row-major layers
 * whose width is the circumference (equirectangular) or four face widths (net).
 */
export type SphereProjection = 'equirect' | 'net';

const cache = new WeakMap<Layer, Partial<Record<SphereProjection, ProjectedLayer>>>();

export function projectSphereLayer(l: Layer, proj: SphereProjection): ProjectedLayer {
  let c = cache.get(l);
  if (!c) cache.set(l, (c = {}));
  return (c[proj] ??= proj === 'net' ? cubeNet(l) : equirect(l));
}

function equirect(l: Layer): ProjectedLayer {
  const n = l.w;
  const W = 4 * n;
  const H = 2 * n;
  const out = new Float32Array(W * H);
  const src = l.data;
  const cosLon = new Float64Array(W);
  const sinLon = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
    cosLon[x] = Math.cos(lon);
    sinLon[x] = Math.sin(lon);
  }
  const t = new Float64Array(3);
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat);
    const z = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      dirToFaceXY(cl * cosLon[x], cl * sinLon[x], z, n, t);
      const cx = Math.min(n - 1, Math.floor(t[1]));
      const cy = Math.min(n - 1, Math.floor(t[2]));
      out[y * W + x] = src[(t[0] * n + cy) * n + cx];
    }
  }
  // worldKm is the face width, so the map is 4 × worldKm (the circumference) wide.
  return flatLayer(l, W, H, out, 'equirect');
}

/** A projected layer: a plain row-major raster (no faces), which remembers its projection and planet radius. */
export type ProjectedLayer = Layer & { projection: SphereProjection };

function flatLayer(l: Layer, w: number, h: number, data: Float32Array, projection: SphereProjection): ProjectedLayer {
  const { faces, ...rest } = l;
  void faces;
  return { ...rest, w, h, worldKm: 4 * l.worldKm, data, projection };
}

/** Net positions (column, row) of faces 0–5: the equatorial ring 3 0 1 2, north (4) above 0, south (5) below. */
const NET: readonly (readonly [number, number])[] = [[1, 1], [2, 1], [3, 1], [0, 1], [1, 0], [1, 2]];

function cubeNet(l: Layer): ProjectedLayer {
  const n = l.w;
  const W = 4 * n;
  const H = 3 * n;
  const out = new Float32Array(W * H).fill(NaN);
  for (let f = 0; f < 6; f++) {
    const [cx, cy] = NET[f];
    for (let y = 0; y < n; y++) {
      const row = (cy * n + y) * W + cx * n;
      const s = (f * n + y) * n;
      for (let x = 0; x < n; x++) out[row + x] = l.data[s + x];
    }
  }
  return flatLayer(l, W, H, out, 'net');
}

/** Latitude and longitude (degrees) of an equirectangular map position in km (x east from 180° W, y south from the pole). */
export function equirectLatLon(l: Layer, xKm: number, yKm: number): [number, number] {
  return [90 - (yKm / (l.worldKm / 2)) * 180, (xKm / l.worldKm) * 360 - 180];
}
