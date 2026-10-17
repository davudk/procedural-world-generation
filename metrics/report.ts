/**
 * Self-contained HTML report (inline CSS + SVG, no scripts) and a Markdown summary of a metrics run.
 */
import type { ArchAgg, BandAgg, RateAgg } from './aggregate';
import type { Summary } from './lib/math';
import type { SuiteResult } from './runner';
import { ALL_BAND_IDS, BANDS, CLARK_EVANS, CONTRAST, COUNT_TARGETS, GEOMORPH, QUIET, SEED_PASS_BAR, SPHERE_BANDS, type BandDef, type BandId } from './targets';

/** Bands present in any of the rows (flat W R A L; spheres add G), in display order. */
const bandIds = (as: readonly ArchAgg[]): BandId[] => ALL_BAND_IDS.filter((id) => as.some((a) => a.bands[id]));
/** Band definition for a band id in these rows (sphere W is the fixed cap). */
const bandDef = (as: readonly ArchAgg[], id: BandId): BandDef => {
  const sphereOnly = !as.some((a) => a.shape !== 'sphere' && a.bands[id]);
  return (sphereOnly ? SPHERE_BANDS : BANDS).find((b) => b.id === id) ?? SPHERE_BANDS.find((b) => b.id === id)!;
};
const bandTitle = (as: readonly ArchAgg[], id: BandId): string => {
  const b = bandDef(as, id);
  const what = b.globe ? 'whole planet (orthographic disc, 2R)' : `${b.nominalKm} km${b.scalesWithWorld ? ' (= world width)' : ''}`;
  return `Band ${b.id} — ${what}, target ${b.lo}–${b.hi}, empty disk ≤ ${b.globe ? `${b.emptyCapKm} km × 2R / 1024 km` : `${b.emptyCapKm} km`}`;
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmt(v: number, d = 2): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(Math.min(d, 0));
  if (a >= 10) return v.toFixed(Math.min(d, 1));
  return v.toFixed(d);
}
const pct = (v: number): string => (Number.isFinite(v) ? `${Math.round(v * 100)} %` : '–');
const tri = (s: Summary, d = 1): string => `${fmt(s.p5, d)} / <b>${fmt(s.p50, d)}</b> / ${fmt(s.p95, d)}`;

/** Pass-rate class: ≥ 90 % good, ≥ 50 % warn, else bad. */
function rc(rate: number): string {
  if (!Number.isFinite(rate)) return 'na';
  return rate >= SEED_PASS_BAR ? 'good' : rate >= 0.5 ? 'warn' : 'bad';
}
const cell = (rate: number, text?: string): string => `<td class="${rc(rate)}">${text ?? pct(rate)}</td>`;
const okCell = (ok: boolean, text: string): string => `<td class="${ok ? 'good' : 'bad'}">${text}</td>`;

function hist(b: BandAgg): string {
  const W = 220;
  const H = 54;
  const pad = 12;
  const max = Math.max(1, ...b.hist);
  const top = Math.max(b.hist.length * b.histBin, b.hi * 1.6);
  const xs = (v: number): number => (v / top) * W;
  const bw = Math.max(1, xs(b.histBin) - 1);
  let s = `<svg class="hist" viewBox="0 0 ${W} ${H + pad}" width="${W}" height="${H + pad}" role="img" aria-label="count histogram">`;
  s += `<rect x="${xs(b.lo)}" y="0" width="${xs(b.hi) - xs(b.lo)}" height="${H}" class="band"/>`;
  s += `<line x1="${xs(b.hi * 1.5)}" x2="${xs(b.hi * 1.5)}" y1="0" y2="${H}" class="cap"/>`;
  b.hist.forEach((c, i) => {
    const h = (c / max) * (H - 2);
    s += `<rect x="${xs(i * b.histBin)}" y="${H - h}" width="${bw}" height="${h}" class="bar"><title>${i * b.histBin}–${(i + 1) * b.histBin - 1}: ${c}</title></rect>`;
  });
  s += `<text x="0" y="${H + pad - 1}">0</text><text x="${W}" y="${H + pad - 1}" text-anchor="end">${Math.round(top)}</text>`;
  s += `<text x="${xs((b.lo + b.hi) / 2)}" y="${H + pad - 1}" text-anchor="middle">${b.lo}–${b.hi}</text>`;
  return `${s}</svg>`;
}

const label = (a: ArchAgg): string => `${a.archetype}${a.group === 'preview' ? '' : ` <span class="tag">${esc(a.group)}</span>`}${a.shape === 'sphere' ? ` <span class="tag">${a.planetKm} km planet</span>` : ''}`;

function headline(as: ArchAgg[]): string {
  const ids = bandIds(as);
  const bandCols = ids.map((id) => `<th>${id}</th>`).join('');
  let s = `<table><thead><tr><th rowspan="2">archetype</th><th rowspan="2">seeds</th><th colspan="${ids.length}">band pass (seeds, all three)</th><th colspan="5">🎯 targets met</th><th colspan="4">contrast</th><th rowspan="2">heroes 3–5</th><th rowspan="2">boring</th><th rowspan="2">cluttered</th></tr>`;
  s += `<tr>${bandCols}<th>contin.</th><th>ranges</th><th>rifts</th><th>river dens.</th><th>wetland</th><th>&lt;300 m</th><th>&gt;2 km</th><th>king</th><th>W view</th></tr></thead><tbody>`;
  for (const a of as) {
    s += `<tr><th>${label(a)}</th><td>${a.seeds}</td>`;
    for (const id of ids) s += a.bands[id] ? cell(a.bands[id].seedPass.all) : '<td class="na">–</td>';
    for (const t of ['continentCount', 'mountainRangeCount', 'riftCount', 'riverDensity', 'wetlandShare']) s += cell(a.targets[t].rate);
    s += cell(a.contrast.lowOk) + cell(a.contrast.highOk) + cell(a.contrast.kingOk) + cell(a.contrast.wViewOk);
    s += cell(a.heroes.inRange);
    s += `<td class="${a.boringRate > 0.1 ? 'bad' : a.boringRate > 0 ? 'warn' : 'good'}">${pct(a.boringRate)}</td>`;
    s += `<td class="${a.clutteredRate > 0.1 ? 'bad' : a.clutteredRate > 0 ? 'warn' : 'good'}">${pct(a.clutteredRate)}</td></tr>`;
  }
  return `${s}</tbody></table>`;
}

function bandTable(all: ArchAgg[], id: BandId): string {
  const as = all.filter((a) => a.bands[id]);
  const b0 = bandDef(as, id);
  let s = `<table><thead><tr><th>archetype</th><th>view</th><th>count p5 / p50 / p95<br><small>target ${b0.lo}–${b0.hi}</small></th><th>histogram</th><th>uniform</th><th>ocean views (½ target)</th>`;
  s += `<th>empty disk p50 / p95 km<br><small>cap</small></th><th>≤ cap</th><th>entropy p50<br><small>≥ ${b0.entropyMin}</small></th><th>≥ min</th><th>CV p50<br><small>0.4–1.2</small></th><th>labels p95</th>`;
  s += `<th>seed pass: count / empty / entropy</th><th>what fills the view (mean per view)</th></tr></thead><tbody>`;
  for (const a of as) {
    const b = a.bands[id];
    const top = Object.entries(b.classMean).sort((x, y) => y[1] - x[1]).slice(0, 7).map(([k, v]) => `${esc(k)} ${fmt(v, 1)}`).join(', ');
    s += `<tr><th>${label(a)}</th><td>${fmt(b.viewKm, 0)} km</td>`;
    s += okCell(b.pass.count, tri(b.pooled, 0)) + `<td>${hist(b)}</td><td>${tri(b.uniform, 0)}</td><td>${b.ocean.n ? tri(b.ocean, 0) : '–'}</td>`;
    s += okCell(b.pass.empty, `${fmt(b.emptyKm.p50, 1)} / ${fmt(b.emptyKm.p95, 1)}<br><small>${fmt(b.capKm, 0)}</small>`) + cell(b.emptyOk);
    s += okCell(b.pass.entropy, fmt(b.entropy.p50)) + cell(b.entropyOk) + okCell(b.pass.cv, fmt(b.cv.p50));
    s += `<td>${fmt(b.labels.p95, 0)}</td>`;
    s += `<td><span class="${rc(b.seedPass.count)}">${pct(b.seedPass.count)}</span> / <span class="${rc(b.seedPass.empty)}">${pct(b.seedPass.empty)}</span> / <span class="${rc(b.seedPass.entropy)}">${pct(b.seedPass.entropy)}</span></td>`;
    s += `<td class="small">${top}</td></tr>`;
  }
  return `${s}</tbody></table>`;
}

function rateTable(as: ArchAgg[], rows: { key: string; label: string; unit: string; get: (a: ArchAgg) => RateAgg | undefined; note?: string }[]): string {
  let s = `<table class="wide"><thead><tr><th>metric</th><th>target</th>${as.map((a) => `<th>${label(a)}</th>`).join('')}</tr></thead><tbody>`;
  for (const r of rows) {
    const any = as.map(r.get).find(Boolean);
    const range = any?.range;
    s += `<tr><th>${esc(r.label)}${r.note ? `<br><small>${esc(r.note)}</small>` : ''}</th><td>${range ? `${fmt(range[0])}–${fmt(range[1])}` : '–'} <small>${esc(r.unit)}</small></td>`;
    for (const a of as) {
      const g = r.get(a);
      s += g ? cell(g.passRate, `${fmt(g.summary.p50)}<br><small>${pct(g.passRate)}</small>`) : '<td class="na">–</td>';
    }
    s += '</tr>';
  }
  return `${s}</tbody></table>`;
}

function targetsTable(as: ArchAgg[]): string {
  const ids = ['continentCount', 'mountainRangeCount', 'riftCount', 'riverDensity', 'wetlandShare'];
  let s = `<table><thead><tr><th>archetype</th>${ids.map((i) => `<th>${i}<br><small>met (alt) · got p50 [p5–p95] · drawn/value mean</small></th>`).join('')}</tr></thead><tbody>`;
  for (const a of as) {
    s += `<tr><th>${label(a)}</th>`;
    for (const i of ids) {
      const t = a.targets[i];
      s += cell(t.rate, `${pct(t.rate)} <small>(${pct(t.rateAlt)})</small><br>${fmt(t.got.p50)} [${fmt(t.got.p5)}–${fmt(t.got.p95)}] · ${fmt(t.drawnMean)}`);
    }
    s += '</tr>';
  }
  return `${s}</tbody></table><p class="note">Counts: met = realised value inside the resolved range (the config panel's ✓); alt = equals the drawn value (continents) or within ±1 of it (ranges, rifts). riverDensity: met = realised/expected drainage density within ±10 % of 1; alt = the config panel's rule (outcome within ±10 % of the riverDensity value). wetlandShare: met = within ±10 % of the resolved value; alt = inside 4–10 % of land.</p>`;
}

function featureTable(as: ArchAgg[]): string {
  const keys = Object.keys(as[0]?.features ?? {});
  let s = `<table class="wide"><thead><tr><th>feature</th><th>per</th>${as.map((a) => `<th>${label(a)}</th>`).join('')}</tr></thead><tbody>`;
  for (const k of keys) {
    const per = as[0].features[k].per;
    s += `<tr><th>${esc(k)}</th><td><small>${per === 'land' ? '10⁵ km² land' : per === 'coast' ? '1000 km coast' : '10⁵ km² warm sea'}</small></td>`;
    for (const a of as) {
      const f = a.features[k];
      s += f ? `<td>${fmt(f.rate.p50)}<br><small>n ${fmt(f.count.p50, 0)}</small></td>` : '<td>–</td>';
    }
    s += '</tr>';
  }
  return `${s}</tbody></table>`;
}

function miscTable(as: ArchAgg[]): string {
  let s = `<table class="wide"><thead><tr><th>metric</th><th>target</th>${as.map((a) => `<th>${label(a)}</th>`).join('')}</tr></thead><tbody>`;
  const row = (name: string, target: string, f: (a: ArchAgg) => string): void => {
    s += `<tr><th>${name}</th><td>${target}</td>${as.map((a) => f(a)).join('')}</tr>`;
  };
  row('land &lt; 300 m (share)', `≥ ${CONTRAST.lowShare}`, (a) => cell(a.contrast.lowOk, `${fmt(a.contrast.lowShare.p50)}<br><small>${pct(a.contrast.lowOk)}</small>`));
  row('land &gt; 2000 m (share)', `≥ ${CONTRAST.highShare}`, (a) => cell(a.contrast.highOk, `${fmt(a.contrast.highShare.p50, 3)}<br><small>${pct(a.contrast.highOk)}</small>`));
  row('king / p95 peak', `≥ ${CONTRAST.kingRatio}`, (a) => cell(a.contrast.kingOk, `${fmt(a.contrast.kingRatio.p50)}<br><small>${pct(a.contrast.kingOk)}</small>`));
  row('W views with ≥ 2 contrasts', '100 %', (a) => cell(a.contrast.wViewOk));
  row('quiet land share', `${QUIET.share[0]}–${QUIET.share[1]}`, (a) => cell(a.quiet.passRate, `${fmt(a.quiet.summary.p50)}<br><small>${pct(a.quiet.passRate)}</small>`));
  row('largest biome share', '≤ 0.7 (boring)', (a) => `<td>${fmt(a.biomeMax.p50)} <small>[${fmt(a.biomeMax.p95)}]</small></td>`);
  row('heroes (p50)', '3–5, spacing ≥ ¼ world', (a) => cell(Math.min(a.heroes.inRange, a.heroes.spacingOk), `${fmt(a.heroes.count.p50, 0)}<br><small>in range ${pct(a.heroes.inRange)}, spaced ${pct(a.heroes.spacingOk)}</small>`));
  for (const t of ['common', 'uncommon', 'rare', 'legendary']) row(`tier ${t} (p50)`, t === 'rare' ? 'P(≥1) 0.6–0.9' : '', (a) => `<td>${fmt(a.tiers[t].p50, 0)}${t === 'rare' ? `<br><small>P(≥1) ${pct(a.rareAtLeastOne)}</small>` : ''}</td>`);
  for (const [k, r] of Object.entries(GEOMORPH)) row(esc(k), `${r[0]}–${r[1]}`, (a) => cell(a.geomorph[k].passRate, `${fmt(a.geomorph[k].summary.p50)}<br><small>${pct(a.geomorph[k].passRate)}</small>`));
  for (const [k, r] of Object.entries(CLARK_EVANS)) row(`Clark–Evans ${esc(k)}`, `${r[0]}–${r[1]}`, (a) => cell(a.clarkEvans[k].passRate, `${fmt(a.clarkEvans[k].summary.p50)}<br><small>n ${a.clarkEvans[k].summary.n}, ${pct(a.clarkEvans[k].passRate)}</small>`));
  return `${s}</tbody></table>`;
}

function flags(as: ArchAgg[], base: string): string {
  let s = '';
  for (const a of as) {
    if (!a.boring.length && !a.cluttered.length) continue;
    s += `<details><summary><b>${label(a)}</b>: ${a.boring.length} boring, ${a.cluttered.length} cluttered of ${a.seeds}</summary>`;
    const tally = (t: Record<string, number>): string => Object.entries(t).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${esc(k)} (${v})`).join('; ');
    if (a.boring.length) s += `<p><b>Boring reasons:</b> ${tally(a.boringReasons)}</p>`;
    if (a.cluttered.length) s += `<p><b>Cluttered reasons:</b> ${tally(a.clutteredReasons)}</p>`;
    s += '<table><thead><tr><th>seed</th><th>link</th><th>boring</th><th>cluttered</th></tr></thead><tbody>';
    const seeds = [...new Set([...a.boring, ...a.cluttered].map((f) => f.seed))].sort((x, y) => x - y);
    for (const seed of seeds) {
      const b = a.boring.find((f) => f.seed === seed);
      const c = a.cluttered.find((f) => f.seed === seed);
      const q = (b ?? c)!.query;
      s += `<tr><td>${seed}</td><td><a href="${esc(base)}?${esc(q)}">?${esc(q)}</a></td><td class="small">${esc(b?.reasons.join('; ') ?? '')}</td><td class="small">${esc(c?.reasons.join('; ') ?? '')}</td></tr>`;
    }
    s += '</tbody></table></details>';
  }
  return s || '<p>No flagged seeds.</p>';
}

function shapeTable(r: SuiteResult): string {
  if (!r.shape.length) return '';
  const sizes = Object.keys(r.shape[0].values).map(Number);
  let s = `<h3>Sphere vs equal-area flat world</h3><p class="note">Research 10 §7: each planet against a flat world of the same area (width √(4πR²)), same archetype and seeds, both in preview (sphere 6 × 128² cells, flat 256²). Values: sphere / flat mean.</p>`;
  s += `<table><thead><tr><th>metric</th>${sizes.map((z) => `<th>${z} km planet<br><small>flat ${Math.round(z / Math.sqrt(Math.PI))} km</small></th>`).join('')}<th>max dev</th><th>tol</th></tr></thead><tbody>`;
  for (const row of r.shape) {
    s += `<tr><th>${esc(row.key)}</th>${sizes.map((z) => `<td>${fmt(row.values[z][0])} / ${fmt(row.values[z][1])}</td>`).join('')}${okCell(row.ok, pct(row.maxDev))}<td>±${Math.round(row.tol * 100)} %</td></tr>`;
  }
  return `${s}</tbody></table>`;
}

function sizeTable(r: SuiteResult): string {
  if (!r.size.length) return '<p>Not run.</p>';
  const sizes = Object.keys(r.size[0].values).map(Number);
  let s = `<table><thead><tr><th>metric</th>${sizes.map((z) => `<th>${z} km</th>`).join('')}<th>max dev</th><th>tol</th></tr></thead><tbody>`;
  for (const row of r.size) {
    s += `<tr><th>${esc(row.key)}</th>${sizes.map((z) => `<td>${fmt(row.values[z])}</td>`).join('')}${okCell(row.ok, pct(row.maxDev))}<td>±${Math.round(row.tol * 100)} %</td></tr>`;
  }
  return `${s}</tbody></table>`;
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a66;--line:#dedbd3;--good:#d8efd9;--warn:#fbecc4;--bad:#f6d3cf;--na:#eeece7;--bar:#4b6a8a;--band:#cfe3cf;--cap:#b33}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#17181a;--fg:#e8e6e1;--mut:#a09e98;--line:#34353a;--good:#1f3d26;--warn:#4a3d16;--bad:#4d2320;--na:#26272a;--bar:#8fb3d9;--band:#244a2a;--cap:#f77}}
:root[data-theme=dark]{--bg:#17181a;--fg:#e8e6e1;--mut:#a09e98;--line:#34353a;--good:#1f3d26;--warn:#4a3d16;--bad:#4d2320;--na:#26272a;--bar:#8fb3d9;--band:#244a2a;--cap:#f77}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:16px}
main{max-width:1600px;margin:0 auto}h1{font-size:22px;margin:4px 0 2px}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin:18px 0 6px}
.meta,.note,small{color:var(--mut)}.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;margin:6px 0 12px;font-variant-numeric:tabular-nums}th,td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:var(--bg)}
td.good,span.good{background:var(--good)}td.warn,span.warn{background:var(--warn)}td.bad,span.bad{background:var(--bad)}td.na{background:var(--na)}span.good,span.warn,span.bad{padding:0 3px;border-radius:3px}
.small{font-size:12px}.tag{font-size:11px;border:1px solid var(--line);border-radius:3px;padding:0 3px;color:var(--mut)}
svg.hist .bar{fill:var(--bar)}svg.hist .band{fill:var(--band)}svg.hist .cap{stroke:var(--cap);stroke-dasharray:3 2}svg.hist text{font-size:9px;fill:var(--mut)}
details{margin:6px 0}summary{cursor:pointer}a{color:var(--bar)}
`;

export function renderHtml(r: SuiteResult): string {
  const as = r.archetypes.filter((a) => !a.group.startsWith('size-') && !a.group.startsWith('flat-'));
  const sizeAs = r.archetypes.filter((a) => a.group.startsWith('size-') || a.group.startsWith('flat-'));
  const o = r.meta.options;
  const countRows = COUNT_TARGETS.map((t) => ({
    key: t.key, label: `${t.label} (${t.row})`, unit: t.per === 'land' ? '/10⁵ km² land' : t.per === 'coast' ? '/1000 km coast' : t.per === 'share' ? 'of land' : 'per world',
    get: (a: ArchAgg) => a.counts[t.key], ...(t.note ? { note: t.note } : {}),
  }));
  const wrap = (x: string): string => `<div class="scroll">${x}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Density Metrics</title><style>${CSS}</style></head><body><main>
<h1>Density &amp; quality metrics</h1>
<p class="meta">${esc(r.meta.startedAt)} · ${r.meta.worlds} worlds in ${fmt(r.meta.seconds, 0)} s on ${r.meta.workers} workers · preview ${o.archetypes.length} archetypes × ${o.seeds} seeds (from ${o.seedStart}), build ${esc(o.buildArchetypes.join(', '))} × ${o.buildSeeds}, size sweep ${esc(o.sizeArchetype)} ${o.sizes.join('/')} × ${o.sizeSeeds} · ${o.views.land}+${o.views.uniform} viewports per band (W: ¼)${r.meta.failures.length ? ` · <b>${r.meta.failures.length} failures</b>` : ''}</p>
<p class="note">Targets: research 05 §3.2 (bands), §3.3 (Clark–Evans, quiet zones), §3.6 (contrast), §4 (counts), §5 (validation). Green ≥ 90 % of seeds (the M8 bar), amber ≥ 50 %, red below. A "distinct feature" is a landmark, Strahler stream (order ≥ the band's minimum), lake or landform feature whose size lies in [view/80, view×1.5]; rivers come from the river graph and lakes from the lake list instead of their landmarks. Preview grids are 256² (4 km cells at 1024 km), so the L band (16 km view = 4 cells) and lakes/islands under 16 km² are below resolution there; the build subset shows the 1 km grid.</p>
<h2>Headline</h2>${wrap(headline(as))}
${bandIds(as).map((id) => `<h2>${bandTitle(as, id)}</h2>${wrap(bandTable(as, id))}`).join('\n')}
<h2>🎯 Target satisfaction</h2>${wrap(targetsTable(as))}
<h2>Counts vs research 05 §4 (median; share of seeds in range)</h2><p class="note">Per-world rows are for the 1024 km default world. Rates per 10⁵ km² land or per 1000 km coast.</p>${wrap(rateTable(as, countRows))}
<h2>Contrast, quiet zones, heroes, tiers, geomorphic realism, clustering</h2>${wrap(miscTable(as))}
<h2>All feature rates (median)</h2>${wrap(featureTable(as))}
<h2>Size invariance (${esc(o.sizeArchetype)}, ${o.shape === 'sphere' ? 'sphere planets, preview' : o.sizeMode})</h2><p class="note">Research 05 §5.5: rates per 10⁵ km² within ±20 % and same-band viewport metrics within ±15 % of the ${o.shape === 'sphere' ? '4,096 km planet' : '1024 km'} value. ${o.shape === 'sphere' ? 'The sphere preview grid is fixed at 6 × 128², so the cell size grows with the planet (4 / 8 / 16 / 23 km at 2,048 / 4,096 / 8,192 / 12,000 km).' : o.sizeMode === 'preview' ? 'The preview grid is fixed at 256², so cell size changes with world size (2 / 4 / 8 km) and resolution effects are mixed into the comparison; run with --size-mode build-const for a 1 km-cell sweep.' : 'Build mode with lemGrid = size/2 and macroGrid = size, i.e. 1 km macro cells at every size.'}</p>${wrap(sizeTable(r))}${wrap(shapeTable(r))}
${sizeAs.length ? `<h3>Size sweep bands</h3>${wrap(headline(sizeAs))}` : ''}
<h2>Flagged seeds</h2><p class="note">Boring: W view p50 &lt; 15, no hero, relief contrast failed (&lt; 25 % of land under 300 m or &lt; 5 % over 2000 m), one biome &gt; 70 % of land, or no lake ≥ 100 km² and no river of order ≥ 6. Cluttered: a W view with &gt; 60 features, label candidates per screen p95 &gt; 60 in any band, quiet land &lt; 5 %, or a 100 km disk with more volcanoes / peaks / lakes than 3× the cluster target.</p>
${flags(r.archetypes, o.baseUrl)}
${r.meta.failures.length ? `<h2>Failures</h2><pre>${esc(r.meta.failures.join('\n'))}</pre>` : ''}
</main></body></html>`;
}

export function renderMarkdown(r: SuiteResult): string {
  const as = r.archetypes.filter((a) => !a.group.startsWith('size-') && !a.group.startsWith('flat-'));
  const ids = bandIds(as);
  const defs = ids.map((id) => bandDef(as, id));
  const na = (a: ArchAgg, id: BandId, f: (b: BandAgg) => string): string => (a.bands[id] ? f(a.bands[id]) : '–');
  const p = (v: number): string => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–');
  const lines: string[] = [];
  lines.push('# Metrics summary', '');
  lines.push(`${r.meta.startedAt} — ${r.meta.worlds} worlds in ${r.meta.seconds.toFixed(0)} s on ${r.meta.workers} workers. Full tables: report.html.`, '');
  lines.push('## Seed pass rates (preview unless tagged)', '');
  lines.push(`| archetype | ${ids.join(' | ')} | continents | ranges | rifts | riverDens | wetland | <300 m | >2 km | king | ice | top peak | boring | cluttered |`);
  lines.push(`|---|${ids.map(() => '---').join('|')}|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const a of as) {
    const t = a.targets;
    lines.push(`| ${a.archetype}${a.group === 'preview' ? '' : ` (${a.group})`} | ${ids.map((id) => na(a, id, (b) => p(b.seedPass.all))).join(' | ')} | ${p(t.continentCount.rate)} | ${p(t.mountainRangeCount.rate)} | ${p(t.riftCount.rate)} | ${p(t.riverDensity.rate)} | ${p(t.wetlandShare.rate)} | ${p(a.contrast.lowOk)} | ${p(a.contrast.highOk)} | ${p(a.contrast.kingOk)} | ${p(a.iceShare.p50)} | ${fmt(a.peakMax.p50, 0)} | ${p(a.boringRate)} | ${p(a.clutteredRate)} |`);
  }
  lines.push('', '## Pooled viewport counts (p5 / p50 / p95, land-weighted)', '');
  lines.push(`| archetype | ${defs.map((b) => `${b.id} (${b.lo}–${b.hi})`).join(' | ')} |`);
  lines.push(`|---|${defs.map(() => '---').join('|')}|`);
  for (const a of as) {
    lines.push(`| ${a.archetype}${a.group === 'preview' ? '' : ` (${a.group})`} | ${ids.map((id) => na(a, id, (b) => {
      const s = b.pooled;
      return `${fmt(s.p5, 0)} / ${fmt(s.p50, 0)} / ${fmt(s.p95, 0)}`;
    })).join(' | ')} |`);
  }
  lines.push('', '## Empty disk ≤ cap (share of land viewports)', '');
  lines.push(`| archetype | ${defs.map((b) => `${b.id} (≤ ${b.globe ? 'scaled' : `${b.emptyCapKm} km`})`).join(' | ')} |`);
  lines.push(`|---|${defs.map(() => '---').join('|')}|`);
  for (const a of as) lines.push(`| ${a.archetype}${a.group === 'preview' ? '' : ` (${a.group})`} | ${ids.map((id) => na(a, id, (b) => `${p(b.emptyOk)} (p50 ${fmt(b.emptyKm.p50, 1)})`)).join(' | ')} |`);
  // Failing count targets.
  lines.push('', '## Count targets failing in most archetypes (median, share of seeds in range)', '');
  const pre = as.filter((a) => a.group === 'preview');
  for (const t of COUNT_TARGETS) {
    const rates = pre.map((a) => a.counts[t.key].passRate);
    const passing = rates.filter((x) => x >= SEED_PASS_BAR).length;
    if (passing >= pre.length / 2) continue;
    const r0 = pre[0]?.counts[t.key].range ?? t.range;
    lines.push(`- **${t.label}** (target ${fmt(r0[0])}–${fmt(r0[1])} ${t.per}${pre[0]?.shape === 'sphere' && t.per === 'world' ? ', scaled to the planet' : ''}): ${pre.map((a) => `${a.archetype} ${fmt(a.counts[t.key].summary.p50)} (${p(a.counts[t.key].passRate)})`).join(', ')}`);
  }
  lines.push('', '## Most-flagged seeds', '');
  for (const a of pre) {
    const top = (fs: ArchAgg['boring']): string => fs.slice(0, 3).map((f) => `[${f.seed}](?${f.query}) ${f.reasons[0]}`).join('; ');
    if (a.boring.length || a.cluttered.length) lines.push(`- ${a.archetype}: boring ${a.boring.length}/${a.seeds}${a.boring.length ? ` — ${top(a.boring)}` : ''}; cluttered ${a.cluttered.length}/${a.seeds}${a.cluttered.length ? ` — ${top(a.cluttered)}` : ''}`);
  }
  if (r.size.length) {
    lines.push('', '## Size invariance', '');
    const bad = r.size.filter((x) => !x.ok);
    lines.push(`${r.size.length - bad.length}/${r.size.length} rows within tolerance. Out of tolerance: ${bad.map((x) => `${x.key} (${Math.round(x.maxDev * 100)}%)`).join(', ') || 'none'}.`);
  }
  if (r.shape.length) {
    lines.push('', '## Sphere vs equal-area flat', '');
    const bad = r.shape.filter((x) => !x.ok);
    lines.push(`${r.shape.length - bad.length}/${r.shape.length} rows within tolerance. Out of tolerance: ${bad.map((x) => `${x.key} (${Math.round(x.maxDev * 100)}%)`).join(', ') || 'none'}.`);
  }
  if (r.meta.failures.length) lines.push('', `**${r.meta.failures.length} worlds failed** — see report.html.`);
  return `${lines.join('\n')}\n`;
}
