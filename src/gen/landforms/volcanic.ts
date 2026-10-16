import { Noise2 } from '../../shared/noise';
import { B } from '../stages/plates';
import {
  areaFactor, cellOf, centreOf, DiskSet, forDisk, localMax, plateCellAt, poisson, ringMean, settleFixed, shuffle, Outline, snapshot, sstep, stampRadial,
} from './profiles';
import type { LandformCtx } from './types';

/** An active volcanic centre placed by this pass (km, metres). */
interface Centre {
  kind: 'stratovolcano' | 'shield-volcano';
  x: number;
  y: number;
  /** Base radius (km). */
  R: number;
  /** Base level the cone rises from (m) and summit (m). */
  base: number;
  summit: number;
  /** Cone surface (m) at offset (dx, dy) km from the centre, as stamped (before any caldera). */
  cone: (dx: number, dy: number) => number;
}

const CONVERGENT: readonly number[] = [B.COLLISION, B.SUBDUCTION, B.ARC];

/**
 * Fresh volcanism after erosion (FEATURES B1–B8, B11; research 01 §6.2, research 05 §3.3–§4).
 * The pre-erosion stamps stage already built the old, dissected arc and hotspot edifices; this pass
 * adds the young/active generation on the same geology:
 * - stratovolcanoes along active arcs (ocean–ocean island arcs and ocean–continent cordilleras),
 *   100–300 km behind the trench, Poisson-disk spaced (bimodal: none away from arcs). A site with an
 *   old edifice nearby snaps onto it (a young cone on the old massif) instead of doubling it;
 * - young shield volcanoes at the active (leading, +v) end of detected hotspot tracks;
 * - calderas on a `calderaShare` of the large volcanoes: ring rim, flat floor below the rim so the
 *   hydro stage fills caldera lakes in wet climates;
 * - cinder-cone fields along continental rifts and on the flanks of active centres;
 * - a `geothermal` mask (0–255) around active centres, plus 'geothermal' marker features.
 */
export function applyVolcanic(c: LandformCtx): void {
  const snap = snapshot(c);
  const { n } = c;
  const P = c.plates;
  const W = n * c.cellKm;
  const vol = c.num('volcanism') * c.num('density_volcanic');
  const af = areaFactor(c);
  const geo = new Uint8Array(n * n);
  const centres: Centre[] = [];
  const noise = new Noise2(c.rng('volcanic-noise').nextU32());
  const occupied = new DiskSet(64);
  let rejuvenated = 0;

  if (vol > 0.05) {
    // ── Stratovolcanoes on active arcs ───────────────────────────────────────────────────────
    const srng = c.rng('strato');
    const cands: { x: number; y: number; island: boolean }[] = [];
    for (let pc = 0; pc < P.n * P.n; pc++) {
      const nb = P.nearest[pc];
      const seg = P.bSeg[nb] >= 0 ? P.segments[P.bSeg[nb]] : null;
      if (!seg) continue;
      const d = P.dBKm[pc];
      if (d < 90 || d > 300) continue;
      const island = seg.cls === B.ARC && seg.overriding === P.plate[pc];
      const cordillera = seg.cls === B.SUBDUCTION && P.continent[pc] !== -1;
      if (!island && !cordillera) continue;
      // Volcanic front: most centres sit ~120–180 km behind the trench.
      if (srng.float() > Math.exp(-(((d - 150) / 55) ** 2))) continue;
      cands.push({
        x: ((pc % P.n) + srng.float()) * P.cellKm,
        y: (Math.floor(pc / P.n) + srng.float()) * P.cellKm,
        island,
      });
    }
    shuffle(srng, cands);
    const spacing = Math.max(25, 80 / Math.sqrt(Math.min(4, vol)));
    const cap = Math.ceil(80 * af);
    const disk = new DiskSet(spacing * 1.3);
    let strato = 0;
    for (const cd of cands) {
      if (strato >= cap) break;
      if (cd.x < 0.02 * W || cd.y < 0.02 * W || cd.x > 0.98 * W || cd.y > 0.98 * W) continue;
      if (!disk.free(cd.x, cd.y, spacing * srng.range(0.85, 1.25))) continue;
      let { x, y } = cd;
      const site = cellOf(c, x, y);
      // Old dissected edifice nearby (from the stamps stage): grow the young cone on top of it.
      const top = localMax(c, x, y, 10);
      let onOld = false;
      if (c.h[top] - c.h[site] > 250) {
        ({ x, y } = centreOf(c, top));
        onOld = true;
      }
      const R = cd.island ? srng.range(8, 14) : srng.range(10, 20);
      // Island-arc cones stand on a shallow arc platform (≥ −400 m) with a skirt down to the sea
      // floor at 2R, so the emergent island is wider than a single grid cell.
      const ringR = ringMean(c, x, y, R * 1.05);
      const base = cd.island ? Math.max(ringR, -400) : ringR;
      const floorFar = cd.island ? ringMean(c, x, y, R * 2) : base;
      const hSite = c.h[cellOf(c, x, y)];
      let summit = base + srng.range(1500, 3000) * (0.75 + 0.125 * Math.min(2, vol));
      if (cd.island) summit = Math.max(summit, srng.range(500, 2400));
      summit = Math.min(6800, Math.max(summit, hSite + srng.range(150, 450)));
      if (summit <= 0 && !cd.island) continue;
      disk.add(cd.x, cd.y);
      if (onOld) rejuvenated++;
      const outline = new Outline(srng, noise, x, y, R, {
        amp: srng.range(0.2, 0.32), elong: srng.range(1, 1.2), axis: srng.range(0, Math.PI), lobes: 2 + srng.int(3), lobeAmp: 0.28,
        warp: 0.07, warpKm: Math.max(2, R / 4),
      });
      const gully = gullies(noise, outline, srng.range(0, 100), 3 + R / 4, 0.2);
      const cone = (dx: number, dy: number): number => {
        const t = outline.x(dx, dy);
        if (t > 1) return cd.island && t < 2 ? base + (floorFar - base) * sstep(1, 2, t) : NaN;
        return base + (summit - base) * (1 - t) ** 1.5 * (1 - gully(dx, dy, t));
      };
      stampRadial(c, x, y, R * outline.maxScale * (cd.island ? 2 : 1), 'max', (_r, dx, dy) => cone(dx, dy));
      centres.push({ kind: 'stratovolcano', x, y, R, base, summit, cone });
      occupied.add(x, y);
      c.features.push({ type: 'stratovolcano', x: x * 1000, y: y * 1000, size: 2 * R * 1000, data: { height: summit, island: cd.island ? 1 : 0, rejuvenated: onOld ? 1 : 0 } });
      strato++;
    }
    c.stats['volcanoStrato'] = strato;
    c.stats['volcanoRejuvenated'] = rejuvenated;

    // ── Young shields at the active end of hotspot tracks ─────────────────────────────────────
    const hotspots = c.drawn('hotspotCount');
    let shields = 0;
    let detected = 0;
    if (hotspots > 0) {
      const tracks = detectHotspotHeads(c, occupied);
      detected = tracks.length;
      const hrng = c.rng('shields');
      const hdisk = new DiskSet(150);
      for (const t of tracks) {
        if (shields >= hotspots) break;
        if (!hdisk.free(t.x, t.y, 150)) continue;
        hdisk.add(t.x, t.y);
        const R = hrng.range(30, 60);
        const base = ringMean(c, t.x, t.y, R);
        const summit = Math.min(4500, Math.max(t.h + hrng.range(100, 400), hrng.range(1800, 2800) + 500 * Math.min(2, vol)));
        // Shields: elongated along a rift-zone direction, with lava-flow lobes and light gullying.
        const outline = new Outline(hrng, noise, t.x, t.y, R, {
          amp: hrng.range(0.22, 0.32), elong: hrng.range(1.3, 1.8), axis: hrng.range(0, Math.PI), lobes: 3 + hrng.int(4), lobeAmp: 0.35,
          warp: 0.08, warpKm: Math.max(3, R / 8),
        });
        const gully = gullies(noise, outline, hrng.range(0, 100), 4 + R / 8, 0.08);
        const cone = (dx: number, dy: number): number => {
          const x = outline.x(dx, dy);
          if (x >= 1) return NaN;
          return base + (summit - base) * (1 - x * x) ** 1.5 * (1 - gully(dx, dy, x));
        };
        stampRadial(c, t.x, t.y, R * outline.maxScale, 'max', (_r, dx, dy) => cone(dx, dy));
        centres.push({ kind: 'shield-volcano', x: t.x, y: t.y, R, base, summit, cone });
        occupied.add(t.x, t.y);
        c.features.push({ type: 'shield-volcano', x: t.x * 1000, y: t.y * 1000, size: 2 * R * 1000, data: { height: summit } });
        shields++;
      }
    }
    c.stats['volcanoShield'] = shields;
    c.stats['hotspotHeadsDetected'] = detected;

    // ── Calderas on a share of the large volcanoes ───────────────────────────────────────────
    const crng = c.rng('calderas');
    const large = centres.filter((v) => v.kind === 'shield-volcano' || v.summit - v.base >= 1800);
    shuffle(crng, large);
    const want = Math.floor(c.num('calderaShare') * large.length + crng.float());
    const cdisk = new DiskSet(60);
    let calderas = 0;
    for (const v of large) {
      if (calderas >= want) break;
      if (!cdisk.free(v.x, v.y, 60)) continue;
      const rc = v.kind === 'shield-volcano'
        ? Math.min(10, Math.max(2, v.R * crng.range(0.08, 0.15)))
        : Math.min(12, Math.max(1.5, v.R * crng.range(0.22, 0.38)));
      // Raised-cosine wall at least 2.5 cells wide (no one-cell step at the lake shore), flat floor,
      // irregular (slightly polygonal, noisy) rim.
      const rIn = 0.6 * rc;
      // (On coarse preview grids the wall is capped so the caldera still fits inside the cone.)
      const wall = Math.min(Math.max(0.4 * rc, 2.5 * c.cellKm), Math.max(0.4 * rc, 0.8 * v.R - rIn));
      const rOut = rIn + wall;
      const outline = new Outline(crng, noise, v.x, v.y, 1, { amp: 0.12, maxK: 6, warp: 0.04, warpKm: Math.max(1, rc / 2) });
      // Lowest cone surface around the wall's outer edge (and one cell beyond, for coarse grids).
      const ringMin = (r: number): number => {
        let m = Infinity;
        for (let k = 0; k < 48; k++) {
          const a = (k / 48) * Math.PI * 2;
          for (const f of [0.85, 1, 1.2]) {
            const z = v.cone(r * f * Math.cos(a), r * f * Math.sin(a));
            if (!Number.isNaN(z)) m = Math.min(m, z);
          }
        }
        return m;
      };
      const rim = ringMin(rOut);
      const lo = Math.max(v.base, 20);
      if (!(rim > lo + 100)) continue;
      // The floor should also sit below the cone one grid cell beyond the wall, or a coarse grid
      // sees no closed basin (and hydrology no caldera lake). Walls stay within 1 km.
      const gridRim = ringMin(rOut + c.cellKm) - 40;
      const natural = Math.max(rim - crng.range(250, 800), lo + 0.3 * (rim - lo));
      const floor = Math.max(lo + 10, rim - 1000, Math.min(gridRim, natural));
      stampRadial(c, v.x, v.y, rOut * 1.25, 'min', (_r, dx, dy) => {
        const r = outline.x(dx, dy);
        const s = (r - rIn) / wall;
        if (s >= 1) return NaN;
        return s <= 0 ? floor : floor + (rim - floor) * (0.5 - 0.5 * Math.cos(Math.PI * s));
      });
      cdisk.add(v.x, v.y);
      c.features.push({ type: 'caldera', x: v.x * 1000, y: v.y * 1000, size: 2 * rOut * 1000, data: { depth: rim - floor, floor, rim } });
      // Calderas are the hottest centres: wide geothermal halo.
      halo(c, geo, v.x, v.y, Math.max(15, rOut * 2));
      calderas++;
    }
    c.stats['volcanoCaldera'] = calderas;

    // ── Cinder-cone fields: continental rifts and flanks of active centres ───────────────────
    const frng = c.rng('cinder');
    const fieldSites: { x: number; y: number }[] = [];
    let riftKm = 0;
    for (const s of P.segments) if (s.cls === B.RIFT) riftKm += s.lengthKm;
    const riftCells: number[] = [];
    for (let pc = 0; pc < P.n * P.n; pc++) {
      const nb = P.nearest[pc];
      if (P.bClass[nb] === B.RIFT && P.dBKm[pc] < 50 && P.continent[pc] !== -1) riftCells.push(pc);
    }
    const nRift = Math.min(poisson(frng, (riftKm / 1000) * 2 * Math.min(3, vol)), riftCells.length);
    for (let k = 0; k < nRift * 4 && fieldSites.length < nRift; k++) {
      const pc = riftCells[frng.int(riftCells.length)];
      fieldSites.push({ x: ((pc % P.n) + frng.float()) * P.cellKm, y: (Math.floor(pc / P.n) + frng.float()) * P.cellKm });
    }
    for (const v of centres) {
      if (frng.float() > (v.kind === 'shield-volcano' ? 0.7 : 0.15)) continue;
      const a = frng.range(0, Math.PI * 2);
      const d = v.R * frng.range(0.6, 1.3);
      fieldSites.push({ x: v.x + d * Math.cos(a), y: v.y + d * Math.sin(a) });
    }
    const fdisk = new DiskSet(120);
    let fields = 0;
    let cones = 0;
    const fieldCap = Math.ceil(12 * af);
    for (const f of fieldSites) {
      if (fields >= fieldCap) break;
      if (f.x < 0 || f.y < 0 || f.x >= W || f.y >= W) continue;
      if (c.h[cellOf(c, f.x, f.y)] <= 0 || !fdisk.free(f.x, f.y, 120)) continue;
      fdisk.add(f.x, f.y);
      const radius = frng.range(8, 18);
      const k = 6 + frng.int(20);
      for (let j = 0; j < k; j++) {
        const a = frng.range(0, Math.PI * 2);
        const d = radius * Math.sqrt(frng.float());
        const x = f.x + d * Math.cos(a);
        const y = f.y + d * Math.sin(a);
        const cell = cellOf(c, x, y);
        if (c.h[cell] <= 0) continue;
        const rc = frng.range(0.35, 0.9);
        const hc = frng.range(60, 250);
        const b = c.h[cell];
        // Truncated cone with a summit crater: the cone top is cut flat at 85 % of its height.
        stampRadial(c, x, y, rc, 'max', (r) => b + hc * Math.min(0.85, (1 - r / rc) ** 1.1));
        cones++;
      }
      halo(c, geo, f.x, f.y, radius + 5);
      c.features.push({ type: 'cinder-field', x: f.x * 1000, y: f.y * 1000, size: 2 * radius * 1000, data: { cones: k } });
      fields++;
    }
    c.stats['cinderFields'] = fields;
    c.stats['cinderCones'] = cones;
  }

  // ── Geothermal halo and markers (hot springs 5–15 km around active centres, research 05 §3.3) ─
  const grng = c.rng('geothermal');
  const gdisk = new DiskSet(60);
  const geyserDisk = new DiskSet(300);
  let geoMarkers = 0;
  for (const v of centres) {
    halo(c, geo, v.x, v.y, v.kind === 'shield-volcano' ? Math.max(15, v.R * 0.5) : 10);
    const p = v.kind === 'shield-volcano' ? 0.8 : 0.3;
    if (grng.float() > p || !gdisk.free(v.x, v.y, 60)) continue;
    gdisk.add(v.x, v.y);
    const geyser = grng.float() < 0.3 && geyserDisk.free(v.x, v.y, 300);
    if (geyser) geyserDisk.add(v.x, v.y);
    c.features.push({ type: 'geothermal', x: v.x * 1000, y: v.y * 1000, size: 20000, data: { springs: 5 + grng.int(26), geysers: geyser ? 1 : 0 } });
    geoMarkers++;
  }
  for (const f of c.features) {
    if (f.type !== 'caldera' || !gdisk.free(f.x / 1000, f.y / 1000, 30)) continue;
    gdisk.add(f.x / 1000, f.y / 1000);
    const geyser = grng.float() < 0.5 && geyserDisk.free(f.x / 1000, f.y / 1000, 300);
    if (geyser) geyserDisk.add(f.x / 1000, f.y / 1000);
    c.features.push({ type: 'geothermal', x: f.x, y: f.y, size: 30000, data: { springs: 10 + grng.int(41), geysers: geyser ? 1 : 0 } });
    geoMarkers++;
  }
  c.stats['geothermalMarkers'] = geoMarkers;
  c.masks.set('geothermal', geo);
  c.stats['volcanicDrowned'] = settleFixed(c, snap);
}

/**
 * Radial gully/valley incision: valleys where angular noise crosses zero, `f` valleys around the
 * cone, deepening downslope (share `depth` of the local height above base at the foot).
 */
function gullies(noise: Noise2, o: Outline, phase: number, f: number, depth: number): (dx: number, dy: number, t: number) => number {
  return (dx, dy, t) => {
    const th = o.theta(dx, dy);
    const v = Math.abs(noise.noise(Math.cos(th) * f + phase, Math.sin(th) * f - phase + t * 1.2));
    return depth * t ** 0.7 * (1 - sstep(0, 0.22, v));
  };
}

/** Raises the geothermal mask to a cone of `r` km around (x, y). */
function halo(c: LandformCtx, geo: Uint8Array, x: number, y: number, r: number): void {
  forDisk(c, x, y, Math.max(r, c.cellKm * 0.75), (cell, d) => {
    const v = Math.round(255 * Math.max(0, 1 - d / Math.max(r, c.cellKm)) ** 0.7);
    if (v > geo[cell]) geo[cell] = v;
  });
}

/**
 * Finds the young end of hotspot tracks left by the stamps stage: prominent isolated summits away
 * from convergent margins, whose plate-motion direction (+v) holds no taller summit (older volcanoes
 * trail along −v). Returns them strongest first.
 */
function detectHotspotHeads(c: LandformCtx, occupied: DiskSet): { x: number; y: number; h: number }[] {
  const { n, h } = c;
  const P = c.plates;
  const bc = Math.max(1, Math.round(20 / c.cellKm));
  const nb = Math.ceil(n / bc);
  const bMax = new Float32Array(nb * nb).fill(-Infinity);
  const bIdx = new Int32Array(nb * nb);
  for (let y = 0; y < n; y++) {
    const by = Math.floor(y / bc) * nb;
    for (let x = 0; x < n; x++) {
      const b = by + Math.floor(x / bc);
      const i = y * n + x;
      if (h[i] > bMax[b]) {
        bMax[b] = h[i];
        bIdx[b] = i;
      }
    }
  }
  const peaks: { x: number; y: number; h: number }[] = [];
  for (let by = 0; by < nb; by++) {
    for (let bx = 0; bx < nb; bx++) {
      const b = by * nb + bx;
      const v = bMax[b];
      if (v < 200) continue;
      let isMax = true;
      for (let j = Math.max(0, by - 2); j <= Math.min(nb - 1, by + 2) && isMax; j++) {
        for (let i = Math.max(0, bx - 2); i <= Math.min(nb - 1, bx + 2); i++) {
          const o = j * nb + i;
          if (o !== b && (bMax[o] > v || (bMax[o] === v && o < b))) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      const p = centreOf(c, bIdx[b]);
      if (ringMean(c, p.x, p.y, 90) > v - 1200) continue;
      const pc = plateCellAt(c, p.x, p.y);
      const seg = P.bSeg[P.nearest[pc]] >= 0 ? P.segments[P.bSeg[P.nearest[pc]]] : null;
      if (seg && CONVERGENT.includes(seg.cls) && P.dBKm[pc] < 250) continue;
      if (!occupied.free(p.x, p.y, 60)) continue;
      peaks.push({ ...p, h: v });
    }
  }
  const heads = peaks.filter((a) => {
    const pl = P.plate[plateCellAt(c, a.x, a.y)];
    const s = Math.hypot(P.vx[pl], P.vy[pl]) || 1;
    const ux = P.vx[pl] / s;
    const uy = P.vy[pl] / s;
    return !peaks.some((b) => {
      if (b === a) return false;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      return d < 300 && (dx * ux + dy * uy) / d > 0.8 && b.h > a.h - 300;
    });
  });
  heads.sort((a, b) => b.h - a.h);
  return heads;
}
