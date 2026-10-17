import { Noise2 } from '../../shared/noise';
import { areaFactor, cellOf, DiskSet, featureAt, forDisk, Outline, poisson, settleFixed, snapshot, stampRadial } from './profiles';
import { spherePos } from './sphere';
import type { LandformCtx } from './types';

/** Simple-to-complex transition diameter on Earth (km; research 01 §6.1: ≈ 2–4 km, 3 km in Impact Earth). */
const D_TRANSITION = 3.2;
/** Visible fresh craters per 10⁵ km² of land-or-shallow-sea at impactHistory 1, geologicAge 0.5 (research 05 §4 row 10). */
const RATE = 0.12;
/** Minimum spacing between craters (research 05 §3.3). */
const SPACING_KM = 150;

/**
 * Fresh impact craters after erosion (FEATURES J1, J2, J4, J5; research 01 §6.1, research 05 rows 10–11).
 * Count = Poisson(λ) with λ = RATE · support/10⁵ km² · impactHistory · (0.4 + 1.2·geologicAge) ·
 * density_relief, capped at 3 + 2·impactHistory (rare tier), where support is land plus shallow sea
 * (> −200 m). Diameters follow N(>D) ∝ D⁻² within craterDiameter. Profiles (Pike 1977 / lunar fits):
 * - simple (D < 3.2 km): parabolic bowl, depth 0.2·D, rim 0.036·D;
 * - complex: flat floor (x < 0.5), central peak (≈ 0.4·d), 3–4 terraced wall steps; depth and rim
 *   follow the lunar exponents (D^0.301, D^0.399) anchored to the simple values at the transition
 *   (e.g. D = 20 km → d ≈ 1.1 km, d/D ≈ 0.055);
 * - ejecta blanket h_r·(r/R)⁻³ out to 4R with angular noise.
 * A small random age scales the relief by (1 − 0.7a). The `crater` mask holds ejecta brightness
 * plus radial rays for the youngest craters (renderer brightening). Spacing ≥ 150 km among the fresh
 * craters; the old (pre-erosion) craters are not exposed to this stage, so no check against them.
 */
export function applyCraters(c: LandformCtx): void {
  const snap = snapshot(c);
  const { n, h } = c;
  const N = c.grid.cells;
  const W = n * c.cellKm;
  const flat = c.grid.shape === 'flat';
  const rng = c.rng('fresh-craters');
  const noise = new Noise2(rng.nextU32());
  const mask = new Uint8Array(N);

  let support = 0;
  let supportM2 = 0;
  for (let i = 0; i < N; i++) {
    if (h[i] > -200 && c.ice[i] < 0.3) {
      support++;
      if (!flat) supportM2 += c.grid.area(i);
    }
  }
  const supportKm2 = flat ? support * c.cellKm * c.cellKm : supportM2 / 1e6;
  const lambda = RATE * (supportKm2 / 1e5) * c.num('impactHistory') * (0.4 + 1.2 * c.num('geologicAge')) * c.num('density_relief');
  const cap = Math.round((3 + 2 * c.num('impactHistory')) * Math.max(1, areaFactor(c)));
  const want = Math.min(cap, poisson(rng, lambda));
  const [d0, d1] = c.range('craterDiameter');
  const disk = new DiskSet(SPACING_KM, c.grid);
  // Sphere: candidate sites uniform on the whole surface (no map margin).
  const sp = flat ? null : spherePos(c.grid);
  const dir = new Float64Array(3);
  let placed = 0;
  let complex = 0;

  for (let k = 0; k < want; k++) {
    // N(>D) ∝ D⁻² truncated to [d0, d1] (inverse CDF).
    const q = 1 - (d0 / d1) ** 2;
    const D = d0 / Math.sqrt(1 - rng.float() * q);
    const R = D / 2;
    let site: { x: number; y: number } | null = null;
    for (let t = 0; t < 300 && !site; t++) {
      let x: number;
      let y: number;
      if (sp) {
        const z = rng.range(-1, 1);
        const lon = rng.range(0, Math.PI * 2);
        const rho = Math.sqrt(Math.max(0, 1 - z * z));
        dir[0] = rho * Math.cos(lon);
        dir[1] = rho * Math.sin(lon);
        dir[2] = z;
        ({ x, y } = sp.enc(dir));
      } else {
        x = rng.range(0.05, 0.95) * W;
        y = rng.range(0.05, 0.95) * W;
      }
      const cell = cellOf(c, x, y);
      if (h[cell] > -200 && c.ice[cell] < 0.3 && disk.free(x, y, SPACING_KM)) site = { x, y };
    }
    if (!site) continue;
    disk.add(site.x, site.y);
    const atSea = h[cellOf(c, site.x, site.y)] <= 0;
    const age = rng.range(0, 0.35);
    const keep = 1 - 0.7 * age;
    const isComplex = D >= D_TRANSITION;
    // Complex craters keep the lunar exponents (d ∝ D^0.301, h_r ∝ D^0.399) but are anchored at the
    // terrestrial transition so depth is continuous there (the raw lunar fit is ~2× too deep on Earth).
    const rel = D / D_TRANSITION;
    const depth = (isComplex ? 200 * D_TRANSITION * rel ** 0.301 : 200 * D) * keep;
    const rim = (isComplex ? 36 * D_TRANSITION * rel ** 0.399 : 36 * D) * keep;
    const terraces = 3 + rng.int(2);
    const phase = rng.range(0, 100);
    const ang = (dx: number, dy: number): number => Math.atan2(dy, dx);
    const wob = (a: number, x: number): number => 1 + 0.3 * noise.fbm(Math.cos(a) * 2.5 + phase, Math.sin(a) * 2.5 + x * 0.7, 3);
    // Real rims are slightly polygonal (high harmonics) and a little oblique; the ejecta blanket is
    // lobate. Distance beyond the rim is stretched per direction by the lobed ejecta outline.
    const body = new Outline(rng, noise, site.x, site.y, R, {
      amp: 0.07, maxK: 8, elong: rng.range(1, 1.12), axis: rng.range(0, Math.PI), warp: 0.025, warpKm: Math.max(1, R / 3),
    });
    const ejecta = new Outline(rng, noise, site.x, site.y, 1, { amp: 0.3, lobes: 4 + rng.int(4), lobeAmp: 0.5 });
    const dist = (dx: number, dy: number): number => {
      const x = body.x(dx, dy);
      return x <= 1 ? x : 1 + (x - 1) / ejecta.scale(body.theta(dx, dy));
    };

    stampRadial(c, site.x, site.y, R * 4 * body.maxScale * 1.6, 'add', (_r, dx, dy) => {
      const x = dist(dx, dy);
      if (x > 4) return 0;
      if (x > 1) return rim * x ** -3 * wob(ang(dx, dy), x);
      if (!isComplex) return -depth + (depth + rim) * x * x;
      let v: number;
      if (x <= 0.5) v = -depth;
      else {
        // Terraced wall: stepped smoothstep from floor to rim.
        const u = ((x - 0.5) / 0.5) * terraces;
        const s = Math.floor(u);
        const f = u - s;
        const step = (s + Math.min(1, Math.max(0, (f - 0.45) / 0.55)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (f - 0.45) / 0.55)))) / terraces;
        v = -depth + (depth + rim) * Math.min(1, step) ** 1.3;
      }
      if (x < 0.15) v += 0.4 * depth * (1 - (x / 0.15) ** 2) ** 2;
      return v * (x > 0.85 ? wob(ang(dx, dy), x) : 1);
    });

    // Brightness: ejecta blanket everywhere, rays only for the youngest impacts.
    const rays = age < 0.15;
    const reach = Math.min(150, R * (rays ? 10 : 4));
    forDisk(c, site.x, site.y, Math.max(reach, c.cellKm), (cell, _r, dx, dy) => {
      const x = Math.max(dist(dx, dy), 0.3);
      let b = x <= 1 ? 0.35 : Math.min(1, x ** -2);
      if (rays && x > 1) {
        const a = ang(dx, dy);
        const ray = Math.max(0, noise.noise(Math.cos(a) * 9 + phase, Math.sin(a) * 9 - phase)) ** 2;
        b = Math.max(b, Math.min(1, 2.5 * ray * x ** -0.8));
      }
      const v = Math.round(255 * b * (1 - age));
      if (v > mask[cell]) mask[cell] = v;
    });
    c.features.push({
      type: 'crater', ...featureAt(c, site.x, site.y), size: D * 1000,
      data: { depth, diameter: D * 1000, rim, complex: isComplex ? 1 : 0, age, sea: atSea ? 1 : 0 },
    });
    placed++;
    if (isComplex) complex++;
  }

  c.masks.set('crater', mask);
  c.stats['craterLambda'] = lambda;
  c.stats['cratersFresh'] = placed;
  c.stats['cratersComplex'] = complex;
  c.stats['craterDrowned'] = settleFixed(c, snap);
}
