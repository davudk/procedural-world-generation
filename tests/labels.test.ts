import { describe, expect, it } from 'vitest';
import type { GroundQuery } from '../src/render/camera/ground';
import { OrbitCamera } from '../src/render/camera/orbitCamera';
import { glyphChars, type GlyphMetrics, type GlyphSource } from '../src/render/labels/glyphs';
import { LabelEngine } from '../src/render/labels/labelEngine';
import { labelStyle, STYLE_LAND, STYLE_WATER } from '../src/render/labels/labelStyle';
import { LabelPlacer, type PlacementCandidate } from '../src/render/labels/placement';
import { Projector } from '../src/render/labels/projector';
import { ShelfPacker, sdfFromAlpha } from '../src/render/labels/sdf';
import { layoutAlongPath, textRun } from '../src/render/labels/textLayout';
import type { Landmark, LandmarkKind } from '../src/shared/landmarks';

const SIZE = 1_000_000;

function flatGround(z = 0): GroundQuery {
  return {
    size: SIZE,
    heightAt: () => z,
    raycast(o, d) {
      if (d.z >= 0) return null;
      const t = (z - o.z) / d.z;
      return t >= 0 ? { x: o.x + d.x * t, y: o.y + d.y * t, z } : null;
    },
  };
}

/** Deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fake glyph source: every glyph is 0.6 em wide with ink, spaces have none. */
class FakeGlyphs implements GlyphSource {
  readonly fontPx = 40;
  readonly spread = 10;
  glyph(_style: number, ch: string): GlyphMetrics {
    const adv = 0.6 * this.fontPx;
    if (ch === ' ') return { ax: 0, ay: 0, aw: 0, ah: 0, left: 0, top: 0, advance: adv };
    return { ax: 0, ay: 0, aw: adv + 22, ah: 52, left: -11, top: -41, advance: adv };
  }
}

function landmark(id: number, over: Partial<Landmark> = {}): Landmark {
  return {
    id, kind: 'peak', name: `Mount ${id}`, x: SIZE / 2, y: SIZE / 2, angle: NaN, extentM: 5000,
    importance: 0.5, maxMpp: 1e9, data: {}, tier: 'common', hero: false, ...over,
  };
}

function overlaps(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < a.length; i += 4) {
    for (let j = 0; j < b.length; j += 4) {
      if (a[i] < b[j + 2] && a[i + 2] > b[j] && a[i + 1] < b[j + 3] && a[i + 3] > b[j + 1]) return true;
    }
  }
  return false;
}

describe('SDF generation', () => {
  it('produces a signed field: inside > 0.5 > outside, linear in distance', () => {
    const w = 64, h = 64, R = 14, spread = 8;
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Anti-aliased disk (4×4 supersampling).
        let cov = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - 32, dy = y + (sy + 0.5) / 4 - 32;
          if (dx * dx + dy * dy <= R * R) cov++;
        }
        alpha[y * w + x] = Math.round((cov / 16) * 255);
      }
    }
    const sdf = sdfFromAlpha(alpha, w, h, spread);
    const at = (x: number, y: number): number => sdf[y * w + x] / 255;
    expect(at(32, 32)).toBeGreaterThan(0.5);
    expect(at(32, 32)).toBe(1); // deep inside: saturated
    expect(at(2, 2)).toBe(0); // far outside: saturated
    // Monotone decreasing along a ray from the centre, crossing 0.5 at the radius.
    let prev = Infinity;
    for (let x = 32; x < 62; x++) {
      const v = at(x, 32);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    for (let x = 32; x < 62; x++) {
      const d = x + 0.5 - 32 - R; // signed distance of the pixel centre (positive outside)
      if (Math.abs(d) < spread - 1) expect(at(x, 32)).toBeCloseTo(0.5 - d / (2 * spread), 1);
      if (d < -0.7) expect(at(x, 32)).toBeGreaterThan(0.5);
      if (d > 0.7) expect(at(x, 32)).toBeLessThan(0.5);
    }
  });

  it('shelf packer never overlaps rectangles', () => {
    const p = new ShelfPacker(256, 256, 1);
    const r = rng(3);
    const rects: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const w = 10 + Math.floor(r() * 30), h = 30 + Math.floor(r() * 25);
      const pos = p.pack(w, h);
      if (!pos) break;
      expect(pos.x + w).toBeLessThanOrEqual(256);
      expect(pos.y + h).toBeLessThanOrEqual(256);
      for (const q of rects) expect(pos.x < q[0] + q[2] && pos.x + w > q[0] && pos.y < q[1] + q[3] && pos.y + h > q[1]).toBe(false);
      rects.push([pos.x, pos.y, w, h]);
    }
    expect(rects.length).toBeGreaterThan(15);
  });
});

describe('label style', () => {
  it('water features are italic, ranges/seas/continents are capitalised, rivers follow paths', () => {
    const k = (kind: LandmarkKind, over: Partial<Landmark> = {}) => labelStyle(landmark(1, { kind, ...over }));
    expect(k('river').style).toBe(STYLE_WATER);
    expect(k('lake').style).toBe(STYLE_WATER);
    expect(k('peak').style).toBe(STYLE_LAND);
    expect(k('range').caps && k('sea').caps && k('continent').caps).toBe(true);
    expect(k('island').caps).toBe(false);
    expect(k('river', { path: new Float32Array([0, 0, 100, 0]) }).mode).toBe('path');
    expect(k('range', { angle: 0.3 }).mode).toBe('rotated');
    expect(k('range', { importance: 1 }).sizePx).toBeGreaterThan(k('range', { importance: 0 }).sizePx);
    expect(k('island', { hero: true }).sizePx).toBeGreaterThan(k('island').sizePx);
  });

  it('splits names into characters including diacritics and combining marks', () => {
    expect(glyphChars("Ølfjörð-Ñá'e")).toEqual(['Ø', 'l', 'f', 'j', 'ö', 'r', 'ð', '-', 'Ñ', 'á', "'", 'e']);
    expect(glyphChars('éx')).toEqual(['é', 'x']); // NFC composes
    expect(glyphChars('q́')).toEqual(['q́']); // no precomposed form: stays one glyph
  });
});

function box(id: number, importance: number, x: number, y: number, w = 80, h = 16, hero = false): PlacementCandidate {
  return { id, hero, importance, ax: x, ay: y, boxes: new Float32Array([x - w / 2, y - h / 2, x + w / 2, y + h / 2]) };
}

/** Runs placement until stable (newcomers need a few frames). */
function settle(p: LabelPlacer, c: PlacementCandidate[], w = 800, h = 600, frames = 5): number[] {
  let ids: number[] = [];
  for (let i = 0; i < frames; i++) ids = p.place(c, w, h).map((q) => q.id);
  return ids;
}

describe('placement', () => {
  it('is greedy by importance with heroes first', () => {
    const p = new LabelPlacer();
    const c = [box(1, 0.2, 400, 300), box(2, 0.9, 410, 302), box(3, 0.5, 100, 100), box(4, 0.1, 395, 298, 80, 16, true)];
    const ids = settle(p, c);
    expect(ids).toEqual([4, 3]); // hero 4 wins the cluster over 2 and 1; 3 stands alone
    const p2 = new LabelPlacer();
    expect(settle(p2, [box(1, 0.2, 400, 300), box(2, 0.9, 410, 302)])).toEqual([2]);
  });

  it('never overlaps boxes (with padding) and respects the density cap', () => {
    const r = rng(11);
    const c: PlacementCandidate[] = [];
    for (let i = 0; i < 3000; i++) c.push(box(i, r(), r() * 1600, r() * 900, 30 + r() * 120, 12 + r() * 8));
    const p = new LabelPlacer();
    let placed = p.place(c, 1600, 900);
    for (let f = 0; f < 4; f++) placed = p.place(c, 1600, 900);
    expect(placed.length).toBeGreaterThan(40);
    expect(placed.length).toBeLessThanOrEqual(Math.ceil((1600 * 900) / (120 * 40)));
    const pad = p.opts.padding;
    for (let i = 0; i < placed.length; i++) {
      const bi = placed[i].boxes.map((v, k) => v + (k < 2 ? -pad / 2 : pad / 2));
      for (let j = i + 1; j < placed.length; j++) {
        const bj = placed[j].boxes.map((v, k) => v + (k < 2 ? -pad / 2 : pad / 2));
        expect(overlaps(bi, bj)).toBe(false);
      }
      for (let b = 0; b < placed[i].boxes.length; b += 4) {
        expect(placed[i].boxes[b]).toBeGreaterThanOrEqual(0);
        expect(placed[i].boxes[b + 2]).toBeLessThanOrEqual(1600);
      }
    }
  });

  it('honours hysteresis: stable input is stable, small pans keep the set', () => {
    const r = rng(5);
    const c: PlacementCandidate[] = [];
    for (let i = 0; i < 800; i++) c.push(box(i, r(), 100 + r() * 1400, 100 + r() * 700, 40 + r() * 100, 14));
    const p = new LabelPlacer();
    const a = settle(p, c, 1600, 900);
    const b = settle(p, c, 1600, 900, 1);
    expect(b).toEqual(a);
    // Pan by a few pixels for several frames: same set (labels well inside the view).
    let cur = c;
    for (let f = 1; f <= 6; f++) {
      cur = c.map((q) => ({ ...q, ax: q.ax + f, ay: q.ay - f, boxes: q.boxes!.map((v, k) => v + (k % 2 === 0 ? f : -f)) }));
      const ids = p.place(cur, 1600, 900).map((q) => q.id);
      expect(new Set(ids)).toEqual(new Set(a));
    }
  });

  it('keeps an existing label against lower or equal priority, yields to strictly higher after stabilising', () => {
    const p = new LabelPlacer({ stableFrames: 3 });
    expect(settle(p, [box(10, 0.5, 400, 300)])).toEqual([10]);
    // A newcomer of equal importance (lower id, which would win a fresh tie) does not displace it.
    expect(settle(p, [box(10, 0.5, 400, 300), box(3, 0.5, 405, 300)])).toEqual([10]);
    // A strictly more important newcomer waits stableFrames, then wins.
    const c = [box(10, 0.5, 400, 300), box(20, 0.8, 405, 300)];
    expect(p.place(c, 800, 600).map((q) => q.id)).toEqual([10]);
    expect(p.place(c, 800, 600).map((q) => q.id)).toEqual([10]);
    expect(p.place(c, 800, 600).map((q) => q.id)).toEqual([20]);
  });

  it('newcomers need stable frames; forced labels appear at once', () => {
    const p = new LabelPlacer({ stableFrames: 3 });
    const c = [box(1, 0.5, 200, 200)];
    expect(p.place(c, 800, 600)).toHaveLength(0);
    expect(p.place(c, 800, 600)).toHaveLength(0);
    expect(p.place(c, 800, 600)).toHaveLength(1);
    const q = new LabelPlacer();
    expect(q.place([{ ...box(2, 0.1, 200, 200), force: true }, box(3, 0.9, 205, 200)], 800, 600).map((x) => x.id)).toEqual([2]);
  });

  it('resolves boxes lazily and only for candidates that pass the anchor tests', () => {
    const p = new LabelPlacer({ stableFrames: 1 });
    const c: PlacementCandidate[] = [
      { id: 1, hero: false, importance: 0.9, ax: 100, ay: 100, boxes: null },
      { id: 2, hero: false, importance: 0.5, ax: 110, ay: 105, boxes: null }, // inside 1's density box
      { id: 3, hero: false, importance: 0.4, ax: -10, ay: 100, boxes: null }, // off screen
    ];
    const asked: number[] = [];
    const placed = p.place(c, 800, 600, (q) => {
      asked.push(q.id);
      return new Float32Array([q.ax - 20, q.ay - 8, q.ax + 20, q.ay + 8]);
    });
    expect(placed.map((x) => x.id)).toEqual([1]);
    expect(asked).toEqual([1]);
  });
});

describe('text along a path', () => {
  const run = textRun([10, 10, 10, 10, 10, 10], 1);

  it('lays glyphs out in order and upright on a left-to-right path', () => {
    const pts = [0, 100, 50, 100, 100, 100, 150, 100];
    const r = layoutAlongPath(pts, 4, run)!;
    expect(r).not.toBeNull();
    expect(r.flipped).toBe(false);
    for (let i = 1; i < 6; i++) expect(r.x[i]).toBeGreaterThan(r.x[i - 1]);
    for (let i = 0; i < 6; i++) {
      expect(r.angle[i]).toBeCloseTo(0, 5);
      expect(r.y[i]).toBeCloseTo(100, 5);
    }
    // Spacing equals the advances.
    expect(r.x[1] - r.x[0]).toBeCloseTo(11, 4);
  });

  it('flips a right-to-left path so it reads left to right', () => {
    const pts = [150, 100, 100, 100, 50, 100, 0, 100];
    const r = layoutAlongPath(pts, 4, run)!;
    expect(r.flipped).toBe(true);
    for (let i = 1; i < 6; i++) expect(r.x[i]).toBeGreaterThan(r.x[i - 1]);
    for (let i = 0; i < 6; i++) expect(Math.cos(r.angle[i])).toBeGreaterThan(0.99);
  });

  it('follows a gentle curve, keeps order and stays upright on a descending right-to-left arc', () => {
    const pts: number[] = [];
    // Arc from right to left, bulging up (screen y down).
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 0.5 + Math.PI * 0.25;
      pts.push(300 + 200 * Math.cos(a), 300 - 200 * Math.sin(a)); // x decreases: the path runs right to left
    }
    const r = layoutAlongPath(pts, 41, run)!;
    expect(r).not.toBeNull();
    for (let i = 1; i < 6; i++) expect(r.x[i]).toBeGreaterThan(r.x[i - 1]);
    for (let i = 0; i < 6; i++) expect(Math.cos(r.angle[i])).toBeGreaterThan(0);
    for (let i = 1; i < 6; i++) expect(Math.abs(r.angle[i] - r.angle[i - 1])).toBeLessThan((25 * Math.PI) / 180);
  });

  it('rejects paths that are too short or too curvy, picks the straight stretch', () => {
    expect(layoutAlongPath([0, 0, 30, 0], 2, run)).toBeNull();
    const zig: number[] = [];
    for (let i = 0; i < 20; i++) zig.push(i * 6, i % 2 === 0 ? 0 : 6);
    expect(layoutAlongPath(zig, 20, run)).toBeNull();
    // A hairpin then a long straight: the label lands on the straight part.
    const pts = [0, 0, 20, 20, 0, 40, 40, 40, 300, 40];
    const r = layoutAlongPath(pts, 5, run)!;
    expect(r).not.toBeNull();
    for (let i = 0; i < 6; i++) expect(r.y[i]).toBeCloseTo(40, 3);
  });
});

describe('projector', () => {
  it('matches OrbitCamera.project', () => {
    const cam = new OrbitCamera(flatGround());
    cam.viewW = 1200;
    cam.viewH = 800;
    cam.fitWorld();
    cam.distance = 50_000;
    cam.pitch = 0.6;
    cam.bearing = 0.7;
    const p = new Projector();
    p.update(cam);
    const r = rng(9);
    for (let i = 0; i < 50; i++) {
      const q = { x: cam.target.x + (r() - 0.5) * 60_000, y: cam.target.y + (r() - 0.5) * 60_000, z: r() * 3000 };
      const a = cam.project(q);
      const ok = p.project(q.x, q.y, q.z);
      expect(ok).toBe(a !== null);
      if (a) {
        expect(p.sx).toBeCloseTo(a.sx, 6);
        expect(p.sy).toBeCloseTo(a.sy, 6);
      }
    }
  });
});

describe('label engine', () => {
  function setup(n: number, pitch = 0): { engine: LabelEngine; cam: OrbitCamera; ground: GroundQuery; list: Landmark[] } {
    const ground = flatGround(100);
    const cam = new OrbitCamera(ground);
    cam.viewW = 1600;
    cam.viewH = 900;
    cam.fitWorld();
    cam.pitch = pitch;
    const r = rng(42);
    const kinds: LandmarkKind[] = ['peak', 'lake', 'island', 'range', 'river', 'bay', 'forest', 'sea'];
    const list: Landmark[] = [];
    for (let i = 0; i < n; i++) {
      const kind = kinds[i % kinds.length];
      const x = r() * SIZE, y = r() * SIZE;
      const lm = landmark(i, {
        kind, x, y, importance: r(), hero: i < 4, maxMpp: 1e9, extentM: 10_000 + r() * 50_000,
        name: `${kind === 'river' ? 'Río' : 'Ærø'} ${i} Nórd`,
        angle: kind === 'range' ? r() * Math.PI : NaN,
      });
      if (kind === 'river') {
        const path = new Float32Array(80);
        for (let k = 0; k < 40; k++) {
          path[2 * k] = x - 100_000 + k * 5_000;
          path[2 * k + 1] = y + 15_000 * Math.sin(k / 8);
        }
        lm.path = path;
      }
      list.push(lm);
    }
    const engine = new LabelEngine(new FakeGlyphs());
    engine.setLandmarks(list, SIZE);
    return { engine, cam, ground, list };
  }

  it('places 3000 candidates within budget, without overlaps, and hit-tests them', () => {
    const { engine, cam, ground } = setup(3000);
    let t = 0;
    const times: number[] = [];
    for (let f = 0; f < 30; f++) {
      engine.update({ cam, ground, dpr: 2, timeSec: (t += 1 / 60), exaggeration: 1 });
      times.push(engine.stats.placeMs);
    }
    times.sort((a, b) => a - b);
    const median = times[15];
    // Panning: every frame re-projects and re-lays out (no layout reuse).
    const panTimes: number[] = [];
    const panCam = new OrbitCamera(ground);
    panCam.viewW = cam.viewW;
    panCam.viewH = cam.viewH;
    panCam.fitWorld();
    for (let f = 0; f < 120; f++) {
      panCam.panBy(1500, 300);
      engine.update({ cam: panCam, ground, dpr: 2, timeSec: (t += 1 / 60), exaggeration: 1 });
      if (f >= 20) panTimes.push(engine.stats.placeMs);
    }
    panTimes.sort((a, b) => a - b);
    const panMedian = panTimes[50];
    // eslint-disable-next-line no-console
    console.log(`labels: 3000 landmarks (all in view and zoom band; 375 rivers on paths) → ${engine.stats.candidates} candidates, ${engine.stats.placed} placed, ${engine.stats.glyphs} glyphs; static median ${median.toFixed(3)} ms, panning median ${panMedian.toFixed(3)} ms`);
    expect(panMedian).toBeLessThan(10);
    // Back to the static camera for the checks below.
    for (let f = 0; f < 30; f++) engine.update({ cam, ground, dpr: 2, timeSec: (t += 1 / 60), exaggeration: 1 });
    expect(engine.stats.candidates).toBe(3000);
    expect(engine.stats.placed).toBeGreaterThan(20);
    expect(median).toBeLessThan(5); // ~1 ms in a browser; generous for CI
    expect(engine.instanceCount).toBeGreaterThan(0);
    // Opacities rise to 1 after the fade.
    let maxOpacity = 0;
    for (let i = 0; i < engine.instanceCount; i++) maxOpacity = Math.max(maxOpacity, engine.instances[i * 16 + 12]);
    expect(maxOpacity).toBe(1);
    // Hit test at the centre of a placed label's first box.
    const hits = (engine as unknown as { hits: { lm: Landmark; boxes: Float32Array }[] }).hits;
    expect(hits.length).toBe(engine.stats.placed);
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) expect(overlaps(hits[i].boxes, hits[j].boxes)).toBe(false);
    }
    const b = hits[0].boxes;
    expect(engine.hitTest((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)?.id).toBe(hits[0].lm.id);
    expect(engine.hitTest(-50, -50)).toBeNull();
  });

  it('is stable while static and when tilted, and honours maxMpp', () => {
    const { engine, cam, ground, list } = setup(400, 0.5);
    let t = 0;
    const ids = (): number[] => (engine as unknown as { hits: { lm: Landmark }[] }).hits.map((h) => h.lm.id).sort((a, b) => a - b);
    for (let f = 0; f < 10; f++) engine.update({ cam, ground, dpr: 1, timeSec: (t += 1 / 60), exaggeration: 1 });
    const a = ids();
    expect(a.length).toBeGreaterThan(5);
    engine.update({ cam, ground, dpr: 1, timeSec: (t += 1 / 60), exaggeration: 1 });
    expect(ids()).toEqual(a);
    // Everything outside its zoom band disappears.
    for (const l of list) l.maxMpp = 1;
    engine.setLandmarks(list, SIZE);
    for (let f = 0; f < 5; f++) engine.update({ cam, ground, dpr: 1, timeSec: (t += 1 / 60), exaggeration: 1 });
    expect(engine.stats.candidates).toBe(0);
  });

  it('lays river names along their path', () => {
    const ground = flatGround(0);
    const cam = new OrbitCamera(ground);
    cam.viewW = 1200;
    cam.viewH = 800;
    cam.fitWorld();
    cam.distance = 400_000;
    const path = new Float32Array(60);
    for (let k = 0; k < 30; k++) {
      // Runs east to west (reversed) along a gentle wave through the centre.
      path[2 * k] = SIZE / 2 + 150_000 - k * 10_000;
      path[2 * k + 1] = SIZE / 2 + 10_000 * Math.sin(k / 6);
    }
    const lm = landmark(7, { kind: 'river', name: 'Río Ñandú', path, x: SIZE / 2, y: SIZE / 2 });
    const engine = new LabelEngine(new FakeGlyphs());
    engine.setLandmarks([lm], SIZE);
    for (let f = 0; f < 5; f++) engine.update({ cam, ground, dpr: 1, timeSec: f / 60, exaggeration: 1 });
    expect(engine.stats.placed).toBe(1);
    const xs: number[] = [];
    for (let i = 0; i < engine.instanceCount; i++) {
      xs.push(engine.instances[i * 16]);
      expect(Math.cos(engine.instances[i * 16 + 2])).toBeGreaterThan(0.5);
      expect(engine.instances[i * 16 + 3]).toBe(STYLE_WATER);
    }
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
});

