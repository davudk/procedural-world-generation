import type { AutoCtx, EnumParam, NumberParam, ParamDef, Range, RangeParam, ToggleParam, WorldShape } from './types';

/**
 * The parameter tree (docs/CONFIG.md §2–3). Order here is display order within a section; resolution
 * order comes from `deps`. AUTO formulas are first cuts, retuned in M8.
 */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r = (a: number, b: number): Range => [a, b];
const sphere = (c: AutoCtx): boolean => c.str('worldShape') === 'sphere';
/**
 * Equal-area size S_eff = √(surface area) in km (research 10 §3.1): the world width on flat maps, so
 * flat formulas are unchanged, and √(4πR²) = C/√π on a planet of circumference C. AUTO formulas that
 * scale with the world read it; their deps list worldShape, worldSize and planetSize.
 */
export const sizeEff = (c: AutoCtx): number => (sphere(c) ? c.num('planetSize') / Math.sqrt(Math.PI) : c.num('worldSize'));
const SIZE: readonly string[] = ['worldShape', 'worldSize', 'planetSize'];
/** Doublings from the default 1024 km world. */
const s2 = (c: AutoCtx): number => Math.log2(sizeEff(c) / 1024);
const landAreaKm2 = (c: AutoCtx): number => sizeEff(c) ** 2 * c.num('landFraction');

type NoKind<T> = Omit<T, 'kind'>;
const num = (p: NoKind<NumberParam>): NumberParam => ({ kind: 'number', ...p });
const draw = (p: NoKind<RangeParam>): RangeParam => ({ kind: 'draw', ...p });
const spread = (p: NoKind<RangeParam>): RangeParam => ({ kind: 'spread', ...p });
const span = (p: NoKind<RangeParam>): RangeParam => ({ kind: 'span', ...p });
const choice = (p: NoKind<EnumParam>): EnumParam => ({ kind: 'enum', ...p });
const toggle = (p: NoKind<ToggleParam>): ToggleParam => ({ kind: 'toggle', ...p });

/** Plate-count centre before rounding (CONFIG.md §3). */
export function plateCentre(c: AutoCtx): number {
  const a = 0.7 + 0.6 * c.num('tectonicActivity');
  const flat = 5 * (sizeEff(c) / 1024) ** 0.8 * a;
  // A closed planet saturates: Earth has ~15 major and minor plates, not the ~90 the flat rule gives.
  const k = sphere(c) ? Math.min(flat, (8 + 4 * Math.log2(sizeEff(c) / 2048)) * a) : flat;
  return k * c.bias('plateMul');
}

/** Whether a parameter applies to a world shape (`shapes` absent = both). */
export function appliesTo(d: ParamDef, shape: WorldShape): boolean {
  return !d.shapes || d.shapes.includes(shape);
}

export const PARAMS: readonly ParamDef[] = [
  // ── L0 World ────────────────────────────────────────────────────────────────────────────
  choice({
    id: 'worldShape', label: 'World shape', level: 0, section: 'world', stage: 'plates',
    help: 'A flat square map, or a whole planet shown as a globe.',
    options: [
      { value: 'flat', label: 'Flat' },
      { value: 'sphere', label: 'Sphere' },
    ],
    deps: [], auto: () => 'flat',
  }),
  num({
    id: 'worldSize', label: 'World size', level: 0, section: 'world', stage: 'plates', shapes: ['flat'],
    help: 'Width of the square world. Bigger worlds get more of everything, not sparser features.',
    min: 256, max: 4096, step: 1, unit: 'km', log: true, integer: true,
    deps: [], auto: (c) => c.bias('worldSize'),
  }),
  num({
    id: 'planetSize', label: 'Planet size', level: 0, section: 'world', stage: 'plates', shapes: ['sphere'],
    help: 'Circumference of the planet; one cube face spans a quarter of it. 4,096 km is a small planet, 40,030 km Earth.',
    min: 2048, max: 40030, step: 1, unit: 'km', log: true, integer: true,
    deps: [], auto: (c) => c.bias('planetSize'),
  }),
  num({
    id: 'planetRadius', label: 'Radius', level: 0, section: 'world', stage: 'plates', shapes: ['sphere'], readonly: true,
    help: 'Planet radius, from the circumference.',
    min: 0, max: 10000, step: 1, unit: 'km', integer: true,
    deps: ['planetSize'], auto: (c) => Math.round(c.num('planetSize') / (2 * Math.PI)),
  }),
  num({
    id: 'planetArea', label: 'Surface area', level: 0, section: 'world', stage: 'plates', shapes: ['sphere'], readonly: true,
    help: 'Total surface area, land and sea.',
    min: 0, max: 600, step: 0.1, unit: 'M km²',
    deps: ['planetSize'], auto: (c) => c.num('planetSize') ** 2 / Math.PI / 1e6,
  }),
  num({
    id: 'landFraction', label: 'Land fraction', level: 0, section: 'world', stage: 'base',
    help: 'Share of the world above sea level.',
    min: 0.05, max: 0.8, step: 0.01,
    deps: [], auto: (c) => c.bias('landFraction'),
  }),
  num({
    id: 'tectonicActivity', label: 'Tectonic activity', level: 0, section: 'world', stage: 'plates',
    help: 'Dead craton (0) to very active (1): more plates, higher peaks, more volcanoes and rifts.',
    min: 0, max: 1, step: 0.01,
    deps: [], auto: (c) => c.bias('tectonicActivity'),
  }),
  num({
    id: 'geologicAge', label: 'Geologic age', level: 0, section: 'world', stage: 'plates',
    help: 'Young (0) to old (1): old worlds are lower and rounder, with wider valleys and surviving craters.',
    min: 0, max: 1, step: 0.01,
    deps: [], auto: (c) => c.bias('geologicAge'),
  }),
  span({
    id: 'latitudeSpan', label: 'Latitude span', level: 0, section: 'world', stage: 'climate', shapes: ['flat'],
    help: 'Virtual latitude from the north edge to the south edge. Drives the climate belts.',
    min: -90, max: 90, step: 1, unit: '°',
    deps: [], auto: (c) => r(c.bias('latNorth'), c.bias('latSouth')),
  }),
  num({
    id: 'axialTilt', label: 'Axial tilt', level: 0, section: 'world', stage: 'climate', shapes: ['sphere'],
    help: 'Tilt of the spin axis: sets the strength of the seasons and how far the climate belts swing.',
    min: 0, max: 45, step: 0.1, unit: '°',
    deps: [], auto: (c) => c.bias('axialTilt'),
  }),
  num({
    id: 'temperatureOffset', label: 'Temperature offset', level: 0, section: 'world', stage: 'climate',
    help: 'Shifts every temperature: ice ages below zero, hothouse worlds above.',
    min: -15, max: 15, step: 0.5, unit: '°C',
    deps: [], auto: (c) => c.bias('temperatureOffset'),
  }),
  num({
    id: 'humidity', label: 'Humidity', level: 0, section: 'world', stage: 'climate',
    help: 'Scales how much moisture the oceans supply.',
    min: 0.2, max: 2.5, step: 0.05,
    deps: [], auto: (c) => c.bias('humidity'),
  }),
  choice({
    id: 'quality', label: 'Quality', level: 0, section: 'world', stage: 'plates',
    help: 'Grid resolutions and iteration counts. Fast is for exploring settings.',
    options: [
      { value: 'fast', label: 'Fast' },
      { value: 'standard', label: 'Standard' },
      { value: 'high', label: 'High' },
    ],
    deps: [], auto: () => 'standard',
  }),

  // ── L1 Structure ────────────────────────────────────────────────────────────────────────
  draw({
    id: 'plateCount', label: 'Tectonic plates', level: 1, section: 'structure', stage: 'plates',
    help: 'Number of major plates. Collisions between them raise mountain ranges.',
    min: 2, max: 40, step: 1, integer: true,
    deps: [...SIZE, 'tectonicActivity'],
    auto: (c) => {
      const n = plateCentre(c);
      return r(Math.max(2, Math.round(0.8 * n)), Math.max(2, Math.round(1.2 * n)));
    },
  }),
  num({
    id: 'meanPlateDiameter', label: 'Mean plate size', level: 1, section: 'structure', stage: 'plates',
    help: 'Typical plate diameter, from world size and plate count. Change it via the plate count.',
    min: 0, max: 5000, step: 1, unit: 'km', integer: true, readonly: true,
    deps: [...SIZE, 'plateCount'],
    auto: (c) => Math.round(Math.sqrt(sizeEff(c) ** 2 / c.mid('plateCount'))),
  }),
  num({
    id: 'plateSizeSkew', label: 'Plate size skew', level: 1, section: 'structure', stage: 'plates',
    help: 'Similar-sized plates (0) to one or two giants plus fragments (1).',
    min: 0, max: 1, step: 0.01,
    deps: [], auto: (c) => c.bias('plateSizeSkew'),
  }),
  draw({
    id: 'microplateCount', label: 'Microplates', level: 1, section: 'structure', stage: 'plates',
    help: 'Small plates squeezed between the major ones.',
    min: 0, max: 12, step: 1, integer: true,
    deps: ['plateCount', 'tectonicActivity'],
    auto: (c) => r(0, Math.round(0.2 * c.mid('plateCount') + 2 * c.num('tectonicActivity'))),
  }),
  num({
    id: 'continentalShare', label: 'Continental crust', level: 1, section: 'structure', stage: 'plates',
    help: 'Share of the world covered by continental crust (land plus continental shelf).',
    min: 0.05, max: 0.95, step: 0.01,
    deps: ['landFraction'], auto: (c) => clamp(c.num('landFraction') + 0.1, 0.05, 0.95),
  }),
  draw({
    id: 'continentCount', label: 'Continents', level: 1, section: 'structure', stage: 'plates', target: true,
    help: 'Number of large landmasses (islands not counted).',
    min: 1, max: 12, step: 1, integer: true,
    deps: [...SIZE, 'landFraction'],
    auto: (c) => {
      const k = clamp((1.6 + 1.0 * s2(c) + 3 * (c.num('landFraction') - 0.4)) * c.bias('continentMul'), 1, 12);
      return r(clamp(Math.round(k - 0.8), 1, 12), clamp(Math.round(k + 1.0), 1, 12));
    },
  }),
  num({
    id: 'continentSizeSkew', label: 'Continent size skew', level: 1, section: 'structure', stage: 'plates',
    help: 'Equal continents (0) to one dominant continent plus small ones (1).',
    min: 0, max: 1, step: 0.01,
    deps: ['continentCount'], auto: (c) => (c.mid('continentCount') <= 1 ? 1 : c.bias('continentSizeSkew')),
  }),
  num({
    id: 'islandAbundance', label: 'Island abundance', level: 1, section: 'structure', stage: 'base',
    help: 'Scales island arcs, shelf islands, archipelagos and drowned ranges.',
    min: 0, max: 2, step: 0.05,
    deps: ['landFraction'],
    auto: (c) => clamp(c.bias('islandAbundance') * (1 + 0.8 * (0.4 - c.num('landFraction'))), 0, 2),
  }),
  num({
    id: 'coastRoughness', label: 'Coast roughness', level: 1, section: 'structure', stage: 'base',
    help: 'Target fractal dimension of coastlines. Fjord and ria coasts sit at the high end.',
    min: 1.1, max: 1.45, step: 0.01,
    deps: ['geologicAge'],
    auto: (c) => clamp(c.bias('coastRoughness') + 0.06 * (0.5 - c.num('geologicAge')), 1.1, 1.45),
  }),
  draw({
    id: 'hotspotCount', label: 'Hotspots', level: 1, section: 'structure', stage: 'stamps',
    help: 'Mantle plumes that build volcanic island chains and shield volcanoes.',
    min: 0, max: 30, step: 1, integer: true,
    deps: [...SIZE, 'tectonicActivity'],
    auto: (c) => {
      const k = (sizeEff(c) / 1024) ** 1.5;
      return r(0, Math.round(1 + 2 * c.num('tectonicActivity') * (sphere(c) ? Math.min(k, 25) : k)));
    },
  }),
  num({
    id: 'seaLevelRise', label: 'Sea-level rise', level: 1, section: 'structure', stage: 'refine',
    help: 'Raises the sea after erosion: valleys drown into rias, hills become islands.',
    min: 0, max: 200, step: 5, unit: 'm',
    deps: [], auto: (c) => c.bias('seaLevelRise'),
  }),
  choice({
    id: 'mapEdge', label: 'Beyond the map', level: 1, section: 'structure', stage: 'plates', shapes: ['flat'],
    help: 'Ocean keeps everything inside the map; continent lets rivers drain off-map and dry air arrive.',
    options: [
      { value: 'ocean', label: 'Ocean' },
      { value: 'continent', label: 'Continent' },
    ],
    deps: [], auto: (c) => (c.bias('mapEdgeContinent') > 0.5 ? 'continent' : 'ocean'),
  }),
  num({
    id: 'boundaryWarp', label: 'Boundary irregularity', level: 1, section: 'structure', stage: 'plates',
    help: 'How irregular plate boundaries are.',
    min: 0, max: 1, step: 0.01,
    deps: ['geologicAge'], auto: (c) => clamp(0.3 + 0.5 * c.num('geologicAge'), 0, 1),
  }),

  // ── L2 Mountains & tectonic features ───────────────────────────────────────────────────
  draw({
    id: 'mountainRangeCount', label: 'Mountain ranges', level: 2, section: 'mountains', stage: 'plates', target: true,
    help: 'Major ranges from plate collisions. Steers which plate boundaries converge.',
    min: 0, max: 30, step: 1, integer: true,
    deps: ['plateCount', 'tectonicActivity'],
    auto: (c) => {
      const k = 0.5 * c.mid('plateCount') * (0.5 + c.num('tectonicActivity'));
      return r(clamp(Math.floor(0.6 * k), 0, 30), clamp(Math.ceil(1.2 * k), 1, 30));
    },
  }),
  spread({
    id: 'rangeLength', label: 'Range length', level: 2, section: 'mountains', stage: 'base',
    help: 'Length of collision ranges. Grows with plate size, since boundaries are longer.',
    min: 20, max: 4000, step: 10, unit: 'km', log: true, integer: true,
    deps: ['meanPlateDiameter'],
    auto: (c) => r(Math.round(0.55 * c.num('meanPlateDiameter')), Math.round(1.2 * c.num('meanPlateDiameter'))),
  }),
  spread({
    id: 'rangeWidth', label: 'Range width', level: 2, section: 'mountains', stage: 'base',
    help: 'Width of the uplifted belt across a range.',
    min: 10, max: 800, step: 5, unit: 'km', log: true, integer: true,
    deps: ['rangeLength', 'tectonicActivity'],
    auto: (c) => {
      const l = c.mid('rangeLength') * (0.8 + 0.4 * c.num('tectonicActivity'));
      return r(Math.round(0.22 * l), Math.round(0.4 * l));
    },
  }),
  spread({
    id: 'peakHeight', label: 'Peak height', level: 2, section: 'mountains', stage: 'base',
    help: 'Spread of the highest summits of each range. Drives uplift in the erosion model.',
    min: 200, max: 9000, step: 50, unit: 'm', integer: true,
    deps: ['tectonicActivity', 'geologicAge', ...SIZE],
    auto: (c) => {
      const a = c.num('tectonicActivity');
      const age = 1 - 0.45 * (c.num('geologicAge') - 0.5);
      const lo = (1500 + 2000 * a) * age;
      // Spheres get no size bonus: their summits already reach the 8.9 km ceiling on the small planet (research 11 §3).
      const hi = Math.min(9000, (3000 + 4000 * a + (sphere(c) ? 0 : 500 * Math.max(0, s2(c)))) * age);
      return r(Math.round(lo / 50) * 50, Math.round(hi / 50) * 50);
    },
  }),
  num({
    id: 'plateauChance', label: 'Plateau chance', level: 2, section: 'mountains', stage: 'base',
    help: 'Chance that a continental collision builds a high plateau behind it.',
    min: 0, max: 1, step: 0.01,
    deps: ['tectonicActivity', ...SIZE, 'peakHeight'],
    auto: (c) => clamp((0.1 + 0.3 * c.num('tectonicActivity') + 0.1 * s2(c)) * (c.range('peakHeight')[1] / 5000), 0, 1),
  }),
  draw({
    id: 'riftCount', label: 'Rifts', level: 2, section: 'mountains', stage: 'plates', target: true,
    help: 'Continental rift valleys where plates pull apart.',
    min: 0, max: 10, step: 1, integer: true,
    deps: ['tectonicActivity', 'plateCount', 'continentalShare'],
    // More continental crust means more plate boundaries inside continents, so more rifts (M8).
    auto: (c) => r(0, clamp(Math.round(0.8 * c.num('tectonicActivity') * c.mid('plateCount') * (0.6 + c.num('continentalShare'))), 1, 10)),
  }),
  num({
    id: 'volcanism', label: 'Volcanism', level: 2, section: 'mountains', stage: 'stamps',
    help: 'Scales arc volcano density and hotspot output.',
    min: 0, max: 2, step: 0.05,
    deps: ['tectonicActivity'], auto: (c) => 2 * c.num('tectonicActivity'),
  }),
  num({
    id: 'calderaShare', label: 'Caldera share', level: 2, section: 'mountains', stage: 'landforms',
    help: 'Fraction of large volcanoes that have collapsed into calderas.',
    min: 0, max: 1, step: 0.01,
    deps: ['volcanism', 'geologicAge'], auto: (c) => clamp(0.05 + 0.1 * c.num('volcanism') + 0.1 * c.num('geologicAge'), 0, 1),
  }),
  num({
    id: 'impactHistory', label: 'Impact history', level: 2, section: 'mountains', stage: 'stamps',
    help: 'How heavily the world has been bombarded.',
    min: 0, max: 3, step: 0.05,
    deps: [], auto: (c) => c.bias('impactHistory'),
  }),
  draw({
    id: 'craterCount', label: 'Impact craters', level: 2, section: 'mountains', stage: 'stamps',
    help: 'Visible impact craters. Rare on Earth-like worlds; old worlds keep more, mostly degraded.',
    min: 0, max: 30, step: 1, integer: true,
    deps: [...SIZE, 'landFraction', 'geologicAge', 'impactHistory'],
    auto: (c) => {
      const lambda = (landAreaKm2(c) / 1e5) * 0.2 * (0.5 + c.num('geologicAge')) * c.num('impactHistory');
      return lambda <= 2 ? r(0, clamp(Math.ceil(2 * lambda), 0, 30)) : r(Math.floor(0.5 * lambda), clamp(Math.ceil(1.5 * lambda), 1, 30));
    },
  }),
  spread({
    id: 'craterDiameter', label: 'Crater diameter', level: 2, section: 'mountains', stage: 'stamps',
    help: 'Size spread of impact craters.',
    min: 0.5, max: 300, step: 0.5, unit: 'km', log: true,
    deps: SIZE, auto: (c) => r(3, Math.min(300, Math.round(40 * Math.sqrt(sizeEff(c) / 1024)))),
  }),
  num({
    id: 'strataShare', label: 'Layered rock', level: 2, section: 'mountains', stage: 'base',
    help: 'Share of land on layered sedimentary rock: mesas, escarpments and canyons.',
    min: 0, max: 1, step: 0.01,
    deps: ['geologicAge'], auto: (c) => clamp(c.bias('strataShare') * (0.7 + 0.6 * c.num('geologicAge')), 0, 1),
  }),
  num({
    id: 'karstShare', label: 'Limestone (karst)', level: 2, section: 'mountains', stage: 'base',
    help: 'Share of land on limestone: sinkholes, towers and disappearing rivers.',
    min: 0, max: 0.5, step: 0.01,
    deps: [], auto: (c) => c.bias('karstShare'),
  }),

  // ── L2 Climate ──────────────────────────────────────────────────────────────────────────
  num({
    id: 'poleEquatorGradient', label: 'Pole–equator gradient', level: 2, section: 'climate', stage: 'climate',
    help: 'How much colder high latitudes are than the tropics.',
    min: 0.4, max: 1.5, step: 0.05,
    deps: [], auto: (c) => c.bias('poleEquatorGradient'),
  }),
  num({
    id: 'windOverrideAngle', label: 'Wind override angle', level: 2, section: 'climate', stage: 'climate',
    help: 'Direction the override wind blows toward (0° = north).',
    min: 0, max: 360, step: 5, unit: '°',
    deps: [], auto: () => 0,
  }),
  num({
    id: 'windOverrideStrength', label: 'Wind override', level: 2, section: 'climate', stage: 'climate',
    help: 'Blend between the latitude wind bands (0) and the override direction (1).',
    min: 0, max: 1, step: 0.05,
    deps: [], auto: () => 0,
  }),
  toggle({
    id: 'oceanCurrents', label: 'Ocean currents', level: 2, section: 'climate', stage: 'climate',
    help: 'Warm and cold coastal currents (fog deserts, mild west coasts).',
    deps: ['worldShape', 'mapEdge'], auto: (c) => sphere(c) || c.str('mapEdge') === 'ocean',
  }),
  num({
    id: 'moistureLength', label: 'Moisture reach', level: 2, section: 'climate', stage: 'climate',
    help: 'How far inland ocean moisture travels before raining out.',
    min: 300, max: 4000, step: 50, unit: 'km', integer: true,
    deps: SIZE,
    auto: (c) => {
      const L = 1500 * (sizeEff(c) / 1024) ** 0.4;
      return Math.round((sphere(c) ? Math.min(L, 3000) : L) / 50) * 50;
    },
  }),
  num({
    id: 'seasonality', label: 'Seasonality', level: 2, section: 'climate', stage: 'climate',
    help: 'Strength of summer/winter contrast.',
    min: 0, max: 2, step: 0.05,
    deps: ['worldShape', 'latitudeSpan', 'axialTilt'],
    auto: (c) => {
      if (sphere(c)) return clamp(c.num('axialTilt') / 23.4, 0, 2);
      const [a, b] = c.range('latitudeSpan');
      return clamp(0.6 + (0.4 * Math.abs((a + b) / 2)) / 45, 0, 2);
    },
  }),
  num({
    id: 'glaciation', label: 'Glaciation', level: 2, section: 'climate', stage: 'glacial',
    help: 'Ice extent and how low glaciers reach. Drives fjords, cirques and lake districts.',
    min: 0, max: 2, step: 0.05,
    deps: ['temperatureOffset', 'worldShape', 'latitudeSpan', 'peakHeight'],
    auto: (c) => {
      const [a, b] = c.range('latitudeSpan');
      // A planet always has poles, but their cold already comes from the climate model's latitudes; the
      // flat term only stands in for a map's poleward reach. Spheres read the Earth-like 65° reach, so
      // an Earth-like planet gets the flat Earth-like glaciation (~1) instead of the clamp at 2 (research 11 §3).
      const maxLat = sphere(c) ? 65 : Math.max(Math.abs(a), Math.abs(b));
      return clamp(
        0.25 + (0.5 * (maxLat - 45)) / 20 + (0.25 * (c.range('peakHeight')[1] - 3000)) / 2000 - c.num('temperatureOffset') / 12,
        0,
        2,
      );
    },
  }),
  toggle({
    id: 'fjords', label: 'Fjords', level: 2, section: 'climate', stage: 'glacial',
    help: 'Allow glaciers to carve troughs below sea level on cold mountainous coasts.',
    deps: ['glaciation', 'peakHeight'],
    auto: (c) => c.num('glaciation') >= 0.9 && c.range('peakHeight')[1] >= 3000,
  }),

  // ── L2 Water ────────────────────────────────────────────────────────────────────────────
  num({
    id: 'riverDensity', label: 'River density', level: 2, section: 'water', stage: 'hydro', target: true,
    help: 'How small a catchment starts a river.',
    min: 0.2, max: 3, step: 0.05,
    deps: ['humidity'], auto: (c) => Math.sqrt(c.num('humidity')),
  }),
  num({
    id: 'lakeDensity', label: 'Lake density', level: 2, section: 'water', stage: 'hydro',
    help: 'Scales lakes the grid cannot resolve (kettles, tarns, ponds) and the lake/breach balance.',
    min: 0, max: 5, step: 0.05,
    deps: ['glaciation', 'humidity'], auto: (c) => (0.7 + 0.2 * c.num('glaciation')) * Math.sqrt(c.num('humidity')),
  }),
  num({
    id: 'meanderStrength', label: 'Meanders', level: 2, section: 'water', stage: 'hydro',
    help: 'Global multiplier on meandering; each reach still meanders by its own slope.',
    min: 0, max: 3, step: 0.05,
    deps: [], auto: () => 1,
  }),
  num({
    id: 'wetlandShare', label: 'Wetlands', level: 2, section: 'water', stage: 'hydro', target: true,
    help: 'Share of land that is marsh, swamp, bog or fen.',
    min: 0, max: 0.3, step: 0.005,
    deps: ['humidity'], auto: (c) => clamp(0.07 * Math.pow(c.num('humidity'), 1.5), 0.005, 0.1),
  }),
  num({
    id: 'waveEnergy', label: 'Wave energy', level: 2, section: 'water', stage: 'hydro',
    help: 'High waves smooth deltas into arcs and cusps.',
    min: 0, max: 1, step: 0.05,
    deps: [], auto: () => 0.5,
  }),
  num({
    id: 'tideRange', label: 'Tides', level: 2, section: 'water', stage: 'hydro',
    help: 'Large tides turn river mouths into estuaries.',
    min: 0, max: 1, step: 0.05,
    deps: [], auto: () => 0.3,
  }),

  // ── L2 Feature density families & heroes ───────────────────────────────────────────────
  ...(['relief', 'water', 'volcanic', 'coast', 'ice', 'arid', 'karst'] as const).map((f) =>
    num({
      id: `density_${f}`, label: `Density: ${f}`, level: 2, section: 'features', stage: 'stamps',
      help: `Multiplies the rate of ${f} landmarks (research note 05, §4).`,
      min: 0, max: 3, step: 0.05,
      deps: [], auto: () => 1,
    }),
  ),
  draw({
    id: 'heroCount', label: 'Hero landmarks', level: 2, section: 'features', stage: 'stamps',
    help: 'Guaranteed spectacular landmarks: a great canyon, massif, crater, fjord coast…',
    min: 0, max: 12, step: 1, integer: true,
    deps: SIZE,
    auto: (c) => {
      const S = sizeEff(c);
      if (sphere(c)) return S > 8000 ? r(8, 12) : r(5, 8);
      return S < 768 ? r(2, 4) : S <= 1024 ? r(3, 5) : r(5, 8);
    },
  }),

  // ── L3 Advanced ─────────────────────────────────────────────────────────────────────────
  choice({
    id: 'lemGrid', label: 'Erosion grid', level: 3, section: 'advanced', stage: 'base', shapes: ['flat'],
    help: 'Resolution of the landscape-evolution model.',
    options: [
      { value: '256', label: '256²' },
      { value: '512', label: '512²' },
      { value: '1024', label: '1024²' },
    ],
    deps: ['quality', 'worldSize'],
    auto: (c) => (c.str('quality') === 'fast' ? '256' : c.str('quality') === 'high' && c.num('worldSize') > 2048 ? '1024' : '512'),
  }),
  choice({
    id: 'macroGrid', label: 'Macro grid', level: 3, section: 'advanced', stage: 'refine', shapes: ['flat'],
    help: 'Resolution of hydrology, climate and biomes.',
    options: [
      { value: '512', label: '512²' },
      { value: '1024', label: '1024²' },
      { value: '2048', label: '2048²' },
    ],
    deps: ['quality', 'worldSize'],
    auto: (c) => (c.str('quality') === 'fast' ? '512' : c.str('quality') === 'high' && c.num('worldSize') > 2048 ? '2048' : '1024'),
  }),
  choice({
    id: 'detailGrid', label: 'Detail grid', level: 3, section: 'advanced', stage: 'gpu', shapes: ['flat'],
    help: 'Resolution of the GPU detail heightmap.',
    options: [
      { value: '2048', label: '2048²' },
      { value: '4096', label: '4096²' },
    ],
    deps: ['quality'], auto: (c) => (c.str('quality') === 'fast' ? '2048' : '4096'),
  }),
  choice({
    id: 'faceGrid', label: 'Face grid', level: 3, section: 'advanced', stage: 'base', shapes: ['sphere'],
    help: 'Cells per cube-face edge of the macro grid (six faces); the erosion grid has half as many.',
    options: [
      { value: '256', label: '6 × 256²' },
      { value: '512', label: '6 × 512²' },
      { value: '1024', label: '6 × 1024²' },
    ],
    deps: ['quality'], auto: (c) => (c.str('quality') === 'fast' ? '256' : c.str('quality') === 'high' ? '1024' : '512'),
  }),
  num({
    id: 'lemIterations', label: 'Erosion iterations', level: 3, section: 'advanced', stage: 'lem',
    help: 'Landscape-evolution steps. Older worlds erode longer.',
    min: 10, max: 400, step: 1, integer: true,
    deps: ['geologicAge', 'quality'],
    auto: (c) => {
      const q = c.str('quality') === 'fast' ? 0.75 : c.str('quality') === 'high' ? 1.25 : 1;
      return Math.round((60 + 60 * c.num('geologicAge')) * q);
    },
  }),
  num({
    id: 'latitudeWarp', label: 'Latitude warp', level: 3, section: 'advanced', stage: 'climate',
    help: 'Wobble of the climate belts so isotherms and desert edges do not follow straight rows.',
    min: 0, max: 8, step: 0.5, unit: '°',
    deps: [], auto: () => 3,
  }),
  num({
    id: 'windNoise', label: 'Wind noise', level: 3, section: 'advanced', stage: 'climate',
    help: 'Random swing of the prevailing wind direction.',
    min: 0, max: 45, step: 1, unit: '°',
    deps: [], auto: () => 20,
  }),
  num({
    id: 'orographicStrength', label: 'Orographic rain', level: 3, section: 'advanced', stage: 'climate',
    help: 'Extra rain per metre-per-km of windward rise.',
    min: 0, max: 0.2, step: 0.005,
    deps: [], auto: () => 0.08,
  }),
  num({
    id: 'rainShadowCap', label: 'Rain-shadow cap', level: 3, section: 'advanced', stage: 'climate',
    help: 'Steepest windward rise that still adds rain; lower values soften rain shadows.',
    min: 10, max: 150, step: 5, unit: 'm/km',
    deps: [], auto: () => 60,
  }),
  num({
    id: 'recycling', label: 'Moisture recycling', level: 3, section: 'advanced', stage: 'climate',
    help: 'Share of rain that vegetation re-evaporates; keeps continental interiors from drying out.',
    min: 0, max: 0.7, step: 0.05,
    deps: [], auto: () => 0.35,
  }),
];

export const PARAM_BY_ID: ReadonlyMap<string, ParamDef> = new Map(PARAMS.map((p) => [p.id, p]));

export function param(id: string): ParamDef {
  const p = PARAM_BY_ID.get(id);
  if (!p) throw new Error(`unknown parameter ${id}`);
  return p;
}

export const SECTION_LABELS: Readonly<Record<ParamDef['section'], string>> = {
  world: 'World',
  structure: 'Structure',
  mountains: 'Mountains & tectonics',
  climate: 'Climate',
  water: 'Water',
  features: 'Features',
  advanced: 'Advanced',
};
