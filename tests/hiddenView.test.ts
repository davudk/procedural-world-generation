import { describe, expect, it } from 'vitest';
import { OrbitCamera } from '../src/render/camera/orbitCamera';
import { GlobeCamera } from '../src/render/camera/globeCamera';
import { applyViewSize } from '../src/render/camera/viewCamera';
import { SphereGround } from '../src/render/globe/globeGround';
import { HeightField } from '../src/render/heightField';
import { DetailGround, HeightFn, detailParams } from '../src/render/height/heightFn';
import type { Layer } from '../src/shared/protocol';

/**
 * A hidden browser pane reports a 0 × 0 canvas. Fed to the cameras, a zero side made the fit distance,
 * target and metres per pixel NaN; the NaN footprint then passed every fade test in the height
 * function, so `DetailGround.heightAt` returned NaN too (the reported camera NaN).
 */
describe('hidden view (0 × 0 canvas)', () => {
  const flat = { size: 1e6, heightAt: () => 0, raycast: () => null };

  it('a zero view side is what turned the camera into NaN', () => {
    const c = new OrbitCamera(flat);
    c.viewW = 0;
    c.viewH = 0;
    c.fitWorld();
    c.update(0.016);
    expect(Number.isNaN(c.metresPerPixel())).toBe(true);
  });

  it('applyViewSize skips zero sizes, so both cameras stay finite', () => {
    const c = new OrbitCamera(flat);
    const g = new GlobeCamera(new SphereGround(652e3));
    expect(applyViewSize([c, g], 800, 600)).toBe(true);
    for (const [w, h] of [[0, 0], [800, 0], [0, 600], [Number.NaN, 5]]) {
      expect(applyViewSize([c, g], w, h)).toBe(false);
      c.fitWorld();
      g.fitWorld();
      c.zoomAt(400, 300, 0.5);
      g.zoomAt(400, 300, 0.5);
      c.update(0.016);
      g.update(0.016);
      expect(c.viewW).toBe(800);
      expect(g.viewH).toBe(600);
      for (const v of [c.distance, c.target.x, c.target.y, c.metresPerPixel(), g.distance, g.metresPerPixel()]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('DetailGround never returns NaN for a NaN, zero or infinite footprint', () => {
    const n = 32;
    const size = 32_000;
    const macro = new Float32Array(n * n).map((_, i) => 100 + 50 * Math.sin(i * 0.37));
    const layer = { id: 'elevation', label: '', stage: 'hydro', kind: 'elevation', w: n, h: n, worldKm: size / 1000, unit: 'm', min: 0, max: 200, data: macro } as Layer;
    const hf = new HeightField(layer, null);
    const params = detailParams(size, 128, n, 7);
    const detail = new Float32Array(128 * 128).fill(120);
    const fn = new HeightFn({ size, macro, macroN: n, water: null, params, detail, control: new Uint8Array(64 * 64 * 4).fill(128), controlN: 64 });
    const g = new DetailGround(fn, hf);
    for (const foot of [Number.NaN, 0, -1, Infinity, 20]) {
      expect(Number.isFinite(g.heightAt(16_000, 16_000, foot))).toBe(true);
      expect(Number.isFinite(g.detailHeightAt(16_000, 16_000, foot))).toBe(true);
    }
    g.pxFoot = Number.NaN;
    expect(Number.isFinite(g.heightAt(1000, 2000))).toBe(true);
    const hit = g.raycast({ x: 16_000, y: 16_000, z: 5000 }, { x: 0, y: 0, z: -1 }, Number.NaN);
    expect(hit !== null && Number.isFinite(hit.z)).toBe(true);
  });
});
