import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { crc32, encodeGray16, encodeRgba8, predict } from '../src/app/export/png';
import { buildWorldJson, colorizeLayer, heightmapScale, quantizeHeights, WORLD_JSON_FORMAT } from '../src/app/export/worldExport';
import { FramePacer } from '../src/render/framePacer';
import { autoTier, pickQuality, pixelRatio, qualitySettings, type DeviceProbe } from '../src/render/quality';
import type { Landmark } from '../src/shared/landmarks';
import type { Layer } from '../src/shared/protocol';

// ── PNG ───────────────────────────────────────────────────────────────────────────────────

interface Chunk {
  type: string;
  data: Uint8Array;
  crcOk: boolean;
}

function chunks(png: Uint8Array): Chunk[] {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    out.push({ type, data, crcOk: dv.getUint32(o + 8 + len) === crc32(png, o + 4, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

/** Decodes the IDAT stream back to raw scanlines (reverses the per-row filters). */
function unfilter(png: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const z = Buffer.concat(chunks(png).filter((c) => c.type === 'IDAT').map((c) => Buffer.from(c.data)));
  const f = new Uint8Array(inflateSync(z));
  expect(f.length).toBe((stride + 1) * height);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = f[y * (stride + 1)];
    expect(type).toBeLessThanOrEqual(4);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      out[y * stride + i] = (f[y * (stride + 1) + 1 + i] + predict(type, a, b, c)) & 0xff;
    }
  }
  return out;
}

describe('PNG encoder', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid 16-bit greyscale PNG that round-trips', async () => {
    const w = 37, h = 23;
    const samples = new Uint16Array(w * h);
    for (let i = 0; i < samples.length; i++) samples[i] = (i * 2654435761) >>> 16;
    samples[0] = 0;
    samples[1] = 65535;
    const png = await encodeGray16(w, h, samples, { Description: 'test heights' });
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(cs.every((c) => c.crcOk)).toBe(true);
    const ihdr = new DataView(cs[0].data.buffer, cs[0].data.byteOffset, 13);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), ihdr.getUint8(8), ihdr.getUint8(9), ihdr.getUint8(12)]).toEqual([w, h, 16, 0, 0]);
    expect(new TextDecoder('latin1').decode(cs[1].data)).toBe('Description\0test heights');
    const raw = unfilter(png, w * 2, h, 2);
    const back = new Uint16Array(w * h);
    for (let i = 0; i < back.length; i++) back[i] = (raw[2 * i] << 8) | raw[2 * i + 1];
    expect(back).toEqual(samples);
  });

  it('writes RGBA8 that round-trips through every filter', async () => {
    const w = 16, h = 9;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        // Gradients favour Sub/Up/Average/Paeth; the noisy rows favour None.
        rgba.set(y % 3 === 2 ? [(x * 97 + y * 31) & 255, (x * 13) ^ y, 255 - x, 255] : [x * 16, y * 28, (x + y) * 8, 255], o);
      }
    }
    const png = await encodeRgba8(w, h, rgba);
    const cs = chunks(png);
    expect(cs.every((c) => c.crcOk)).toBe(true);
    expect(cs[0].data[9]).toBe(6);
    expect(unfilter(png, w * 4, h, 4)).toEqual(rgba);
  });

  it('rejects a pixel buffer of the wrong size', async () => {
    await expect(encodeGray16(4, 4, new Uint16Array(15))).rejects.toThrow();
  });
});

// ── Heightmap, colour map and world JSON ──────────────────────────────────────────────────

function layer(over: Partial<Layer> = {}): Layer {
  const w = 4;
  const data = new Float32Array([-4000, -10, 0, 10, 200, 800, 1500, 2500, 3000, 3500, 4200, 5000, 100, 50, 25, 6000]);
  return { id: 'elevation', label: 'Elevation', stage: 'hydro', kind: 'elevation', w, h: w, worldKm: 512, unit: 'm', min: -4000, max: 6000, data, ...over };
}

describe('heightmap export', () => {
  it('maps the elevation range onto 0…65535 with sea level recorded', () => {
    const e = layer();
    const s = heightmapScale(e);
    expect(s).toMatchObject({ encoding: 'uint16-linear', minM: -4000, maxM: 6000, width: 4, height: 4 });
    expect(s.seaLevelValue).toBe(Math.round(0.4 * 65535));
    const q = quantizeHeights(e, s);
    expect(q[0]).toBe(0);
    expect(q[15]).toBe(65535);
    expect(q[2]).toBe(s.seaLevelValue);
    // Decoding with the documented formula recovers metres to within half a step.
    for (let i = 0; i < 16; i++) expect(Math.abs(s.minM + (q[i] / 65535) * (s.maxM - s.minM) - e.data[i])).toBeLessThan(0.1);
  });

  it('colours every layer kind at grid resolution', () => {
    const elev = colorizeLayer(layer());
    expect(elev.length).toBe(4 * 4 * 4);
    expect(elev[3]).toBe(255);
    // Deep ocean is blue-dominant; the 6 km summit is near white.
    expect(elev[2]).toBeGreaterThan(elev[0]);
    expect(Math.min(elev[60], elev[61], elev[62])).toBeGreaterThan(150);
    const cat = colorizeLayer(layer({ kind: 'categorical', data: new Float32Array(16).fill(3) }));
    expect([...cat.subarray(0, 4)]).toEqual([...cat.subarray(4, 8)]);
    const sc = colorizeLayer(layer({ kind: 'scalar', min: 0, max: 15, data: Float32Array.from({ length: 16 }, (_, i) => i) }));
    // Viridis: dark purple at the low end, yellow at the high end.
    expect(sc[0]).toBeLessThan(90);
    expect(sc[15 * 4]).toBeGreaterThan(200);
    expect(sc[15 * 4 + 1]).toBeGreaterThan(200);
  });
});

describe('world JSON export', () => {
  const lm = (id: number, over: Partial<Landmark> = {}): Landmark => ({
    id, kind: 'peak', name: `Peak ${id}`, x: 12_345.678, y: 200_000, angle: NaN, extentM: 4000, importance: 0.5,
    maxMpp: 100, data: { heightM: 4321.06, prominenceM: 1500, bad: NaN }, tier: 'common', hero: false, ...over,
  });

  it('has the documented shape', () => {
    const json = buildWorldJson({
      spec: { seed: 42, archetype: 'fjordland', pins: { worldSize: 2048 } },
      query: 'seed=42&a=fjordland&worldSize=2048',
      shareUrl: 'https://example.test/?seed=42&a=fjordland&worldSize=2048',
      resolved: { worldSize: 2048, landFraction: 0.3 },
      elevation: layer(),
      traits: { headline: 'A cold realm of fjords.', traits: ['5.6 km massif'], heroes: [2] },
      landmarks: [lm(1, { importance: 0.9 }), lm(2, { hero: true, importance: 0.2 }), lm(3, { importance: 0.4 })],
      now: new Date('2026-10-16T12:00:00Z'),
    });
    expect(json.format).toBe(WORLD_JSON_FORMAT);
    expect(json.exportedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(json.spec).toEqual({ seed: 42, archetype: 'fjordland', pins: { worldSize: 2048 } });
    expect(json.world).toEqual({ sizeKm: 512, grid: 4, cellKm: 128, elevationM: [-4000, 6000], seaLevelM: 0 });
    expect(json.heightmap?.encoding).toBe('uint16-linear');
    expect(json.traits?.heroNames).toEqual(['Peak 2']);
    // Heroes first, then by importance.
    expect(json.landmarks.map((l) => l.id)).toEqual([2, 1, 3]);
    expect(json.landmarks[0]).toEqual({
      id: 2, name: 'Peak 2', kind: 'peak', tier: 'common', hero: true, importance: 0.2,
      xKm: 12.346, yKm: 200, extentKm: 4, facts: { heightM: 4321.06, prominenceM: 1500 },
    });
    // Survives a JSON round trip unchanged (no NaN / typed arrays leak in).
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('works before any terrain exists', () => {
    const json = buildWorldJson({ spec: { seed: 1, archetype: 'earthlike', pins: {} }, query: 'seed=1', shareUrl: 'x', resolved: {}, elevation: null, traits: null, landmarks: [] });
    expect(json.world).toBeNull();
    expect(json.heightmap).toBeNull();
    expect(json.landmarks).toEqual([]);
  });
});

// ── Quality tiers and frame pacing ────────────────────────────────────────────────────────

describe('quality tiers', () => {
  const desktop: DeviceProbe = { devicePixelRatio: 2, coarsePointer: false, minScreenCss: 1117, deviceMemoryGB: 8, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)', mobileUA: false };
  const iphone: DeviceProbe = { devicePixelRatio: 3, coarsePointer: true, minScreenCss: 393, deviceMemoryGB: null, renderer: 'Apple GPU', mobileUA: true };

  it('picks high on desktops, low on phones and tablets, medium on 4 GB machines', () => {
    expect(autoTier(desktop)).toBe('high');
    expect(autoTier({ ...desktop, renderer: 'Apple GPU' })).toBe('high'); // Safari on a Mac
    expect(autoTier(iphone)).toBe('low');
    expect(autoTier({ ...desktop, renderer: 'Adreno (TM) 740' })).toBe('low');
    expect(autoTier({ ...desktop, coarsePointer: true, minScreenCss: 820 })).toBe('low'); // iPad in desktop mode
    expect(autoTier({ ...desktop, deviceMemoryGB: 4 })).toBe('medium');
    expect(autoTier({ ...desktop, deviceMemoryGB: 2 })).toBe('low');
  });

  it('low tier: no MSAA, 2048² detail, coarser CDLOD and 0.75 render scale at DPR 3', () => {
    const q = pickQuality('auto', iphone);
    expect(q).toMatchObject({ tier: 'low', msaa: 0, maxDetail: 2048, idleFps: 30 });
    expect(q.vertexPx).toBeGreaterThan(qualitySettings('high').vertexPx);
    expect(pixelRatio(q, 3)).toBeCloseTo(2.25);
    expect(pixelRatio(q, 2)).toBe(2);
    expect(pixelRatio(qualitySettings('high'), 3)).toBe(2);
    expect(pixelRatio(qualitySettings('high'), 1)).toBe(1);
    expect(pickQuality('high', iphone).tier).toBe('high'); // explicit choice wins
  });
});

describe('frame pacer', () => {
  it('draws every frame while busy, then caps idle frames to ~30 fps', () => {
    const p = new FramePacer(30);
    const frame = 1000 / 60;
    let drawn = 0;
    for (let i = 0; i < 30; i++) if (p.shouldDraw(i * frame, true, true)) drawn++;
    expect(drawn).toBe(30);
    drawn = 0;
    const t0 = 30 * frame + p.settleMs;
    for (let i = 0; i < 60; i++) if (p.shouldDraw(t0 + i * frame, false, true)) drawn++;
    expect(drawn).toBe(30);
    // At 120 Hz the cap is still ~30 fps.
    drawn = 0;
    const t1 = t0 + 2000;
    for (let i = 0; i < 120; i++) if (p.shouldDraw(t1 + i * (1000 / 120), false, true)) drawn++;
    expect(drawn).toBe(30);
  });

  it('stops drawing a static scene once settled, and wakes on demand', () => {
    const p = new FramePacer(30);
    expect(p.shouldDraw(0, true, false)).toBe(true);
    expect(p.shouldDraw(100, false, false)).toBe(true); // still settling
    expect(p.shouldDraw(1000, false, false)).toBe(false);
    expect(p.shouldDraw(2000, false, false)).toBe(false);
    p.wake(2010);
    expect(p.shouldDraw(2016, false, false)).toBe(true);
  });
});
