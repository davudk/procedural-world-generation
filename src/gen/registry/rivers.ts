import { RIVER } from '../../shared/protocol';
import { MinHeap } from '../grid/heap';
import { alongPolyline, cellAtM, cellX, cellY, decimate, labelAngle, nearestWhere } from './grid';
import type { Candidate, RegistryInput, Shared } from './types';

/** A traced main stem: reaches from the mouth (or confluence) upstream along the largest discharge. */
export interface Stem {
  reaches: number[];
  /** Node polyline, source → mouth (map metres). */
  xs: number[];
  ys: number[];
  nodes: number[];
  lengthKm: number;
  q: number;
  mouthNode: number;
  /** Stem this one flows into (−1 for a trunk reaching a terminal). */
  joins: number;
}

export interface RiverResult {
  stems: Stem[];
  /** Candidates of the named rivers, parallel to the stem they came from. */
  named: Map<number, Candidate>;
}

/**
 * Water landmarks from the hydrology vectors. Rivers are traced as whole main stems: from every
 * terminal reach (largest discharge first) upstream along the largest-discharge tributary, with the
 * side branches queued as tributary stems, so each river is one named polyline from source to mouth.
 * Lakes from LakeInfo (salt lakes and playas get their own generics), waterfalls from WATERFALL nodes
 * (the biggest drops), deltas from DELTA apexes (named after their river), canyons from long reaches
 * of the main stems whose valley is deeply incised below the surrounding high ground.
 */
export function detectWaters(I: RegistryInput, S: Shared, out: Candidate[], rangeOf: Int32Array): RiverResult {
  const g = I.rivers;
  const R = g.reachStart.length;
  const cellKm = I.fine.cellM / 1000;
  const ups: number[][] = Array.from({ length: R }, () => []);
  const reachOf = new Int32Array(g.n).fill(-1);
  let maxQ = 0;
  for (let r = 0; r < R; r++) {
    if (g.reachDown[r] >= 0) ups[g.reachDown[r]].push(r);
    for (let i = g.reachStart[r]; i < g.reachStart[r] + g.reachLen[r]; i++) reachOf[i] = r;
  }
  for (let i = 0; i < g.n; i++) if (!(g.flags[i] & RIVER.DISTRIBUTARY)) maxQ = Math.max(maxQ, g.q[i]);
  const lastQ = (r: number): number => g.q[g.reachStart[r] + g.reachLen[r] - 1];
  const isDistributary = (r: number): boolean => (g.flags[g.reachStart[r]] & RIVER.DISTRIBUTARY) !== 0;

  // ── Main stems ──
  const qMin = Math.max(0.5, 0.01 * maxQ);
  const claimed = new Uint8Array(R);
  const heap = new MinHeap(256);
  const joinsOf = new Map<number, number>();
  for (let r = 0; r < R; r++) if (g.reachDown[r] < 0 && !isDistributary(r) && lastQ(r) >= qMin) heap.push(-lastQ(r), r);
  const stems: Stem[] = [];
  const stemOfReach = new Int32Array(R).fill(-1);
  while (heap.size > 0 && stems.length < 400) {
    const r0 = heap.pop();
    if (claimed[r0]) continue;
    const reaches: number[] = [];
    let cur = r0;
    for (;;) {
      claimed[cur] = 1;
      reaches.push(cur);
      let best = -1;
      for (const u of ups[cur]) if (!claimed[u] && (best < 0 || lastQ(u) > lastQ(best) || (lastQ(u) === lastQ(best) && u < best))) best = u;
      for (const u of ups[cur]) if (u !== best && !claimed[u] && lastQ(u) >= qMin) {
        heap.push(-lastQ(u), u);
        joinsOf.set(u, stems.length);
      }
      if (best < 0) break;
      cur = best;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const nodes: number[] = [];
    for (let k = reaches.length - 1; k >= 0; k--) {
      const r = reaches[k];
      for (let i = g.reachStart[r]; i < g.reachStart[r] + g.reachLen[r]; i++) {
        xs.push(g.x[i]);
        ys.push(g.y[i]);
        nodes.push(i);
      }
    }
    // The stem ends where its last reach flows into another stem.
    const lastNode = nodes[nodes.length - 1];
    const dn = g.down[lastNode];
    if (dn >= 0) {
      xs.push(g.x[dn]);
      ys.push(g.y[dn]);
    }
    let L = 0;
    for (let i = 1; i < xs.length; i++) L += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const id = stems.length;
    for (const r of reaches) stemOfReach[r] = id;
    stems.push({ reaches, xs, ys, nodes, lengthKm: L / 1000, q: lastQ(r0), mouthNode: lastNode, joins: joinsOf.get(r0) ?? -1 });
  }

  // ── Named rivers: trunks and big tributaries, by length × √discharge ──
  const minLen = Math.max(40, 4 * cellKm);
  const order = stems
    .map((s, i) => ({ s, i, score: s.lengthKm * Math.sqrt(s.q) }))
    .filter(({ s }) => s.lengthKm >= (s.joins < 0 ? minLen : 1.5 * minLen))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const cap = Math.round(Math.min(30, Math.max(5, S.landKm2 / 15000)));
  const named = new Map<number, Candidate>();
  let longest = 0;
  for (const { s } of order) longest = Math.max(longest, s.lengthKm);
  // Delta apexes (for the great-river hero and delta names).
  const apexes: number[] = [];
  for (let i = 0; i < g.n; i++) if (g.flags[i] & RIVER.DELTA && !(g.flags[i] & RIVER.DISTRIBUTARY)) apexes.push(i);
  const hasDelta = new Set<number>();
  for (const a of apexes) if (reachOf[a] >= 0 && stemOfReach[reachOf[a]] >= 0) hasDelta.add(stemOfReach[reachOf[a]]);
  for (const { s, i } of order.slice(0, cap)) {
    const path = decimate(s.xs, s.ys, Math.max(I.fine.cellM, (s.lengthKm * 1000) / 200));
    const a = alongPolyline(path, 0.5);
    const mouthFlags = g.flags[s.mouthNode];
    const strahler = g.strahler[s.mouthNode];
    const delta = hasDelta.has(i);
    const c: Candidate = {
      kind: 'river', x: a.x, y: a.y, angle: labelAngle(a.dx, a.dy), extentM: s.lengthKm * 1000,
      mag: 0.5 * Math.min(1, s.lengthKm / Math.max(longest, 1)) + 0.5 * Math.min(1, Math.log1p(s.q) / Math.log1p(Math.max(maxQ, 1))),
      data: {
        lengthKm: Math.round(s.lengthKm), dischargeM3s: Math.round(s.q * 10) / 10, strahler, basinKm2: Math.round(g.area[s.mouthNode]),
        sourceM: Math.round(g.zWater[s.nodes[0]]), ...(delta ? { delta: 1 } : {}), ...(s.joins >= 0 ? { tributary: 1 } : {}),
        ...(mouthFlags & RIVER.MOUTH_SEA ? { reachesSea: 1 } : {}),
      },
      idX: s.xs[s.xs.length - 1], idY: s.ys[s.ys.length - 1], path,
      hero: { cat: 'great-river', score: (0.5 * s.lengthKm / 500 + 0.5 * s.q / 800) * (delta ? 1.25 : 1) },
      tier: s.lengthKm >= 1500 ? 'legendary' : s.lengthKm >= 1000 ? 'rare' : 'uncommon',
      landmass: S.masses.label[cellAtM(I.fine, a.x, a.y)],
    };
    named.set(i, c);
    out.push(c);
  }

  // ── Deltas ──
  const deltas: Candidate[] = [];
  const ext = new Float64Array(apexes.length);
  if (apexes.length > 0) {
    for (let i = 0; i < g.n; i++) {
      if (!(g.flags[i] & RIVER.DISTRIBUTARY)) continue;
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < apexes.length; k++) {
        const d = Math.hypot(g.x[i] - g.x[apexes[k]], g.y[i] - g.y[apexes[k]]);
        if (d < bd) (bd = d), (best = k);
      }
      if (best >= 0 && bd < 80000) ext[best] = Math.max(ext[best], bd);
    }
  }
  apexes.forEach((a, k) => {
    if (ext[k] < 2000) return;
    const st = reachOf[a] >= 0 ? stemOfReach[reachOf[a]] : -1;
    const c: Candidate = {
      kind: 'delta', x: g.x[a], y: g.y[a], angle: NaN, extentM: ext[k] * 1.5, mag: Math.min(1, Math.log1p(g.q[a]) / Math.log1p(5000)),
      data: { dischargeM3s: Math.round(g.q[a]), lengthKm: Math.round(ext[k] / 100) / 10 }, idX: g.x[a], idY: g.y[a],
      landmass: S.masses.label[cellAtM(I.fine, g.x[a], g.y[a])],
    };
    const river = st >= 0 ? named.get(st) : undefined;
    if (river) c.nameFrom = river;
    deltas.push(c);
  });
  deltas.sort((a, b) => b.data.dischargeM3s - a.data.dischargeM3s);
  out.push(...deltas.slice(0, 6));

  detectLakes(I, S, out);
  detectFalls(I, S, out, reachOf);
  detectCanyons(I, S, out, stems, named, rangeOf);
  return { stems, named };
}

function detectLakes(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const cellKm2 = (I.fine.cellM / 1000) ** 2;
  const minKm2 = Math.max(2 * cellKm2, 3);
  const idx = I.lakes.map((_, i) => i).filter((i) => I.lakes[i].areaKm2 >= minKm2);
  idx.sort((a, b) => I.lakes[b].areaKm2 - I.lakes[a].areaKm2 || a - b);
  const cap = Math.round(Math.min(30, Math.max(5, S.landKm2 / 12000)));
  const n = I.fine.n;
  for (const i of idx.slice(0, cap)) {
    const L = I.lakes[i];
    const fc = nearestWhere(n, L.cx / I.fine.cellM, L.cy / I.fine.cellM, Math.max(4, 2 * Math.sqrt(L.areaKm2 / cellKm2)), (c) => I.hydro.lakeId[c] === i);
    const x = fc >= 0 ? cellX(I.fine, fc) : L.cx;
    const y = fc >= 0 ? cellY(I.fine, fc) : L.cy;
    const variant = L.type === 'playa' ? 'playa' : L.salinity === 2 || L.type === 'salt' ? 'salt' : L.type === 'crater' ? 'crater' : 'lake';
    const salty = variant === 'playa' || variant === 'salt';
    const c: Candidate = {
      kind: 'lake', x, y, angle: NaN, extentM: Math.sqrt(L.areaKm2) * 1000 * 1.2, mag: Math.min(1, Math.log10(Math.max(1, L.areaKm2)) / 4),
      data: { areaKm2: Math.round(L.areaKm2 * 10) / 10, depthM: Math.round(L.maxDepth), levelM: Math.round(L.level), salinity: L.salinity, ...(L.type === 'playa' ? { playa: 1 } : {}) },
      idX: L.cx, idY: L.cy, variant, tier: L.areaKm2 >= 10000 ? 'legendary' : L.areaKm2 >= 2000 ? 'rare' : L.areaKm2 >= 100 ? 'uncommon' : 'common',
      hero: salty ? { cat: 'salt-basin', score: L.areaKm2 / 500 } : { cat: 'great-lake', score: L.areaKm2 / 2000 },
      landmass: fc >= 0 ? S.masses.label[fc] : -1,
    };
    out.push(c);
  }
}

/** Waterfalls: runs of WATERFALL nodes on rivers of ≥ 1 m³/s, by drop × √q, spaced ≥ 8 km. */
function detectFalls(I: RegistryInput, S: Shared, out: Candidate[], reachOf: Int32Array): void {
  const g = I.rivers;
  const list: { node: number; drop: number; score: number }[] = [];
  for (let i = 0; i < g.n; i++) {
    if (!(g.flags[i] & RIVER.WATERFALL)) continue;
    if (i > 0 && reachOf[i - 1] === reachOf[i] && g.flags[i - 1] & RIVER.WATERFALL) continue;
    let drop = 0;
    for (let j = i, steps = 0; j >= 0 && g.flags[j] & RIVER.WATERFALL && steps < 50; steps++) {
      const d = g.down[j];
      if (d < 0) break;
      drop += g.zWater[j] - g.zWater[d];
      j = d;
    }
    if (drop < 15 || g.q[i] < 1) continue;
    list.push({ node: i, drop, score: drop * Math.sqrt(g.q[i]) });
  }
  list.sort((a, b) => b.score - a.score || a.node - b.node);
  const cap = Math.round(Math.min(25, Math.max(3, S.landKm2 / 20000)));
  const kept: number[] = [];
  for (const f of list) {
    if (kept.length >= cap) break;
    const i = f.node;
    if (kept.some((k) => Math.hypot(g.x[k] - g.x[i], g.y[k] - g.y[i]) < 8000)) continue;
    kept.push(i);
    out.push({
      kind: 'waterfall', x: g.x[i], y: g.y[i], angle: NaN, extentM: Math.max(200, g.width[i] * 3), visM: 1500 * Math.sqrt(f.drop / 50),
      mag: Math.min(1, f.drop / 500), data: { heightM: Math.round(f.drop), dischargeM3s: Math.round(g.q[i] * 10) / 10 }, idX: g.x[i], idY: g.y[i],
      landmass: S.masses.label[cellAtM(I.fine, g.x[i], g.y[i])],
    });
  }
}

/**
 * Canyons: runs ≥ 20 km of a main stem where the river lies ≥ 600 m below the highest ground within
 * ~6 km; outside mountain ranges (or ≥ 1.5 km deep inside them, then called a gorge).
 */
function detectCanyons(I: RegistryInput, S: Shared, out: Candidate[], stems: Stem[], named: Map<number, Candidate>, rangeOf: Int32Array): void {
  const g = I.rivers;
  const R = S.reg;
  const m = R.n;
  const near = new Float32Array(m * m);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      let v = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= m || ny >= m) continue;
          v = Math.max(v, S.hMax[ny * m + nx]);
        }
      }
      near[y * m + x] = v;
    }
  }
  const found: Candidate[] = [];
  stems.forEach((s, si) => {
    if (s.lengthKm < 30) return;
    const flush = (a: number, b: number): void => {
      let lenM = 0;
      for (let k = a + 1; k <= b; k++) lenM += Math.hypot(g.x[s.nodes[k]] - g.x[s.nodes[k - 1]], g.y[s.nodes[k]] - g.y[s.nodes[k - 1]]);
      if (lenM < 20000) return;
      let sum = 0;
      let mx = 0;
      let inR = 0;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = a; k <= b; k++) {
        const i = s.nodes[k];
        const rc = cellAtM(R, g.x[i], g.y[i]);
        const d = near[rc] - g.zWater[i];
        sum += d;
        mx = Math.max(mx, d);
        if (rangeOf[rc] >= 0) inR++;
        xs.push(g.x[i]);
        ys.push(g.y[i]);
      }
      const cnt = b - a + 1;
      const mean = sum / cnt;
      const inRange = inR / cnt >= 0.5;
      if (inRange && mean < 1500) return;
      const lenKm = lenM / 1000;
      const path = decimate(xs, ys, Math.max(I.fine.cellM, lenM / 60));
      const at = alongPolyline(path, 0.5);
      const river = named.get(si);
      const score = Math.sqrt((lenKm / 150) * (mean / 1000));
      const c: Candidate = {
        kind: 'canyon', x: at.x, y: at.y, angle: labelAngle(at.dx, at.dy), extentM: lenM, mag: Math.min(1, score / 1.5),
        data: { lengthKm: Math.round(lenKm), depthM: Math.round(mean), maxDepthM: Math.round(mx) }, idX: xs[xs.length - 1], idY: ys[ys.length - 1], path,
        variant: inRange ? 'gorge' : 'canyon', hero: { cat: 'canyon', score },
        tier: lenKm >= 150 && mean >= 1000 ? 'rare' : 'uncommon', landmass: S.masses.label[cellAtM(I.fine, at.x, at.y)],
      };
      if (river && river.data.lengthKm < 2.5 * lenKm) c.nameFrom = river;
      found.push(c);
    };
    let a = -1;
    let b = -1;
    let gapM = 0;
    for (let k = 0; k < s.nodes.length; k++) {
      const i = s.nodes[k];
      const deep = near[cellAtM(R, g.x[i], g.y[i])] - g.zWater[i] >= 600;
      if (deep) {
        if (a < 0) a = k;
        b = k;
        gapM = 0;
      } else if (a >= 0) {
        gapM += Math.hypot(g.x[i] - g.x[s.nodes[k - 1]], g.y[i] - g.y[s.nodes[k - 1]]);
        if (gapM > 3000) {
          flush(a, b);
          a = -1;
        }
      }
    }
    if (a >= 0) flush(a, b);
  });
  found.sort((a, b) => b.mag - a.mag);
  const cap = Math.round(Math.min(4, Math.max(1, S.landKm2 / 100000)));
  const kept: Candidate[] = [];
  for (const c of found) {
    if (kept.length >= cap) break;
    if (kept.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 40000)) continue;
    kept.push(c);
  }
  out.push(...kept);
}
