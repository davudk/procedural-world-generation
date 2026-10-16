import type { Landmark, WorldTraits } from '../../shared/landmarks';
import { G } from './shared';
import type { RegistryInput, Shared } from './types';

/** 12345 → "12,345" (locale-independent). */
export function fmt(v: number, digits = 0): string {
  const s = Math.abs(v).toFixed(digits);
  const [i, d] = s.split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '−' : '') + g + (d ? `.${d}` : '');
}

const article = (w: string): string => (/^[aeiou]/i.test(w) ? 'An' : 'A');

/**
 * World traits (research 05 §3.4, PLAN.md §10): a one-sentence headline from the climate, the
 * dominant character and the two headline landmarks, and 3–8 bullets with numbers.
 */
export function worldTraits(I: RegistryInput, S: Shared, lms: Landmark[], heroes: number[]): WorldTraits {
  const N = I.fine.n * I.fine.n;
  const T = S.totals;
  const landCells = T.landCells;
  const L = Math.max(1, landCells);
  const tMean = T.tempMean;
  const desertShare = T.groupCells[G.DESERT] / L;
  const forestShare = (T.groupCells[G.BOREAL] + T.groupCells[G.TEMPERATE] + T.groupCells[G.TROPICAL]) / L;
  const iceShare = T.iceCells / L;
  const landShare = landCells / N;
  const of = (k: Landmark['kind']): Landmark[] => lms.filter((l) => l.kind === k);
  const best = (k: Landmark['kind'], key: string): Landmark | undefined => {
    let b: Landmark | undefined;
    for (const l of of(k)) if (!b || (l.data[key] ?? 0) > (b.data[key] ?? 0)) b = l;
    return b;
  };

  const climate = tMean < 0 ? 'frozen' : tMean < 6 ? 'cold' : tMean < 13 ? 'temperate' : tMean < 20 ? 'warm' : 'hot';
  const adj = desertShare > 0.3 ? `${climate === 'temperate' ? 'dry' : climate}, arid` : climate;
  const fjords = of('fjord');
  const fjordKm = fjords.reduce((s, f) => s + (f.data.lengthKm ?? 0), 0);
  const volcanoes = of('volcano').length;
  const character =
    landShare < 0.2 ? (fjordKm >= 150 ? 'islands and fjords' : 'islands')
      : fjordKm >= 150 ? 'fjords'
        : desertShare > 0.3 ? (of('erg').length ? 'sand seas and deserts' : 'deserts')
          : iceShare > 0.15 ? 'ice'
            : volcanoes >= 6 ? 'volcanoes'
              : forestShare > 0.45 ? 'forests'
                : of('range').length >= 2 ? 'mountains'
                  : 'plains and rivers';
  const noun = landShare < 0.2 ? 'sea' : 'realm';
  const king = lms.find((l) => l.kind === 'peak' && l.data.worldKing);
  const river = best('river', 'lengthKm');
  const ocean = of('ocean')[0] ?? of('sea')[0];
  const parts: string[] = [];
  if (king) parts.push(`crowned by the ${(king.data.heightM / 1000).toFixed(1)} km ${king.name}`);
  if (river && river.data.lengthKm >= 150) parts.push(`drained by the great ${river.name}`);
  else if (ocean) parts.push(`washed by the ${ocean.name}`);
  const headline = `${article(adj)} ${adj} ${noun} of ${character}${parts.length ? `, ${parts.join(' and ')}` : ''}.`;

  const traits: string[] = [];
  if (king) traits.push(`Highest peak: ${king.name}, ${fmt(king.data.heightM)} m (prominence ${fmt(king.data.prominenceM)} m).`);
  if (river) traits.push(`Longest river: ${river.name}, ${fmt(river.data.lengthKm)} km, ${fmt(river.data.dischargeM3s)} m³/s at its mouth.`);
  const lake = best('lake', 'areaKm2');
  if (lake) traits.push(`Largest lake: ${lake.name}, ${fmt(lake.data.areaKm2)} km²${lake.data.depthM ? `, ${fmt(lake.data.depthM)} m deep` : ''}.`);
  const nCont = S.continents.size;
  const nIsl = S.masses.count - nCont;
  traits.push(
    `Land: ${Math.round(landShare * 100)} % of the map (${fmt(Math.round(S.landKm2 / 1000) * 1000)} km²), ${nCont} continent${nCont === 1 ? '' : 's'} and ${fmt(nIsl)} island${nIsl === 1 ? '' : 's'}.`,
  );
  traits.push(
    `Climate: ${climate}, ${tMean.toFixed(1)} °C mean on land; ${Math.round(desertShare * 100)} % desert, ${Math.round(forestShare * 100)} % forest, ${Math.round(iceShare * 100)} % ice.`,
  );
  const rare: string[] = [];
  const craters = of('crater');
  if (craters.length) {
    const c = craters.reduce((a, b) => (b.data.diameterKm > a.data.diameterKm ? b : a));
    rare.push(`${craters.length} impact crater${craters.length > 1 ? 's' : ''} (${c.name}, ${fmt(c.data.diameterKm, 1)} km)`);
  }
  if (fjordKm > 0) rare.push(`${fjords.length} fjord${fjords.length > 1 ? 's' : ''} totalling ${fmt(fjordKm)} km`);
  if (volcanoes) rare.push(`${volcanoes} volcano${volcanoes > 1 ? 'es' : ''}`);
  const calderas = of('caldera').length;
  if (calderas) rare.push(`${calderas} caldera${calderas > 1 ? 's' : ''}`);
  const atolls = of('atoll').length;
  if (atolls) rare.push(`${atolls} atoll${atolls > 1 ? 's' : ''}`);
  const erg = best('erg', 'areaKm2');
  if (erg) rare.push(`the ${erg.name} (${fmt(erg.data.areaKm2)} km² of dunes)`);
  const canyon = best('canyon', 'lengthKm');
  if (canyon) rare.push(`the ${canyon.name} (${fmt(canyon.data.lengthKm)} km, ${fmt(canyon.data.depthM)} m deep)`);
  if (rare.length) traits.push(`Notable: ${rare.slice(0, 4).join(', ')}.`);
  const hs = heroes.map((id) => lms[id].name);
  if (hs.length) traits.push(`Hero landmarks: ${hs.join(', ')}.`);
  return { headline, traits: traits.slice(0, 8), heroes };
}
