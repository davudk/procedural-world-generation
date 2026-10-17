import type { LandmarkKind } from '../../shared/landmarks';
import { hashMix, hashString, rngFor } from '../../shared/hash';
import type { Rng } from '../../shared/rng';
import type { Geo } from './geo';

/**
 * Procedural place names (PLAN.md §3 S11). Each world picks 3–5 "cultures" from a handful of phoneme
 * inventories and places them as regions (seeded points; a landmark speaks the language of the
 * nearest one, islands that of their island). A name is a 2–3 syllable word built from the
 * language's onsets, nuclei and codas under simple phonotactics (no long consonant runs, no tripled
 * letters), plus a kind-specific English generic ("Mount X", "X River", "Gulf of X"); languages differ
 * in whether they put the generic first. Every name is seeded by the world seed, the language and the
 * landmark's identity (a stable position), never by list order, so names survive unrelated edits.
 */

interface Language {
  id: string;
  onsets: string[];
  nuclei: string[];
  codas: string[];
  /** Probability of a coda on a non-final / final syllable. */
  codaMid: number;
  codaEnd: number;
  /** Probability of a vowel-initial word. */
  vowelStart: number;
  /** Probability of three syllables (else two). */
  p3: number;
  /** Optional word endings replacing the last syllable's rhyme. */
  endings: string[];
  endingP: number;
  /** Probability of the generic-first pattern ("Lake X", "Gulf of X"). */
  preP: number;
  /** Continent-name suffixes. */
  landSuffix: string[];
}

const L = (s: string): string[] => s.split(' ');

/** Phoneme inventories, loosely evoking real language families (no real words are drawn from them). */
const LANGUAGES: readonly Language[] = [
  {
    id: 'north', onsets: L('b d f g h k l m n r s t v sk st br dr gr hr kr tr fj bj sv h t s k'), nuclei: L('a e i o u y a e o ei au aa'),
    codas: L('n r l k t nd rd ld rn st ng m r n'), codaMid: 0.45, codaEnd: 0.7, vowelStart: 0.15, p3: 0.25,
    endings: L('ar ur ik ung ven heim und orn'), endingP: 0.3, preP: 0.25, landSuffix: L('land heim mark'),
  },
  {
    id: 'romance', onsets: L('b c d f l m n p r s t v qu pr tr br gr c l m s v'), nuclei: L('a e i o u a e o ia io ea'),
    codas: L('n r l s n r'), codaMid: 0.2, codaEnd: 0.25, vowelStart: 0.25, p3: 0.55,
    endings: L('a o ia ano era ona ino ella'), endingP: 0.45, preP: 0.85, landSuffix: L('ia ica ara'),
  },
  {
    id: 'island', onsets: L('h k l m n p t w v h k m n t'), nuclei: L('a e i o u a a o ai au ae'),
    codas: [''], codaMid: 0, codaEnd: 0, vowelStart: 0.2, p3: 0.6,
    endings: L('ua oa iki ani ea'), endingP: 0.2, preP: 0.4, landSuffix: L('nui iki'),
  },
  {
    id: 'steppe', onsets: L('b ch d g k t s sh m n y z j k t b'), nuclei: L('a e i o u a a u i'),
    codas: L('r l n k t sh z m y r n'), codaMid: 0.5, codaEnd: 0.75, vowelStart: 0.3, p3: 0.4,
    endings: L('an ar ek ul ish ay'), endingP: 0.3, preP: 0.3, landSuffix: L('stan ar'),
  },
  {
    id: 'gael', onsets: L('b c d g l m n r s t br dr gl gw tr c m l'), nuclei: L('a e i o u ae ei ua ow y'),
    codas: L('n r l th ch ll rn n r'), codaMid: 0.4, codaEnd: 0.65, vowelStart: 0.2, p3: 0.3,
    endings: L('wyn ach ith eth ory'), endingP: 0.3, preP: 0.6, landSuffix: L('ia an'),
  },
  {
    id: 'savanna', onsets: L('b d g k l m n p s t z mb nd ng ny sh ch w k m'), nuclei: L('a e i o u a a o'),
    codas: [''], codaMid: 0, codaEnd: 0.05, vowelStart: 0.1, p3: 0.65,
    endings: L('ani ezi ombe ula aro'), endingP: 0.25, preP: 0.5, landSuffix: L('ia ani'),
  },
  {
    id: 'andes', onsets: L('ch h k l m n p r s t w y hu qu p t'), nuclei: L('a i u a a u e o'),
    codas: L('n y s k r'), codaMid: 0.3, codaEnd: 0.45, vowelStart: 0.15, p3: 0.5,
    endings: L('ay pa ca nqui marca'), endingP: 0.3, preP: 0.7, landSuffix: L('suyu'),
  },
  {
    id: 'east', onsets: L('k s t n h m y r w g z d b sh ch ts k t'), nuclei: L('a i u e o a o'),
    codas: L('n'), codaMid: 0.12, codaEnd: 0.2, vowelStart: 0.1, p3: 0.75,
    endings: L('ra ki mi to shima'), endingP: 0.15, preP: 0.2, landSuffix: L('koku'),
  },
];

const VOWELS = new Set('aeiouy'.split(''));

/** Generic patterns: [generic-first, generic-after] alternatives per kind or kind:variant. */
const PATTERNS: Record<string, [string[], string[]]> = {
  continent: [[], ['{X}']],
  island: [['Isle of {X}'], ['{X} Island']],
  'island:large': [[], ['{X}', '{X} Island']],
  archipelago: [[], ['{X} Archipelago']],
  'archipelago:islands': [[], ['{X} Islands', '{X} Isles']],
  peninsula: [[], ['{X} Peninsula']],
  cape: [['Cape {X}'], ['{X} Point', '{X} Head']],
  isthmus: [['Isthmus of {X}'], ['{X} Isthmus']],
  ocean: [[], ['{X} Ocean']],
  sea: [['Sea of {X}'], ['{X} Sea']],
  gulf: [['Gulf of {X}'], ['{X} Gulf', '{X} Bight']],
  bay: [['Bay of {X}'], ['{X} Bay', '{X} Sound']],
  strait: [['Strait of {X}'], ['{X} Strait', '{X} Channel', '{X} Narrows']],
  lagoon: [[], ['{X} Lagoon']],
  range: [[], ['{X} Mountains', '{X} Range']],
  'range:highlands': [[], ['{X} Highlands']],
  'range:hills': [[], ['{X} Hills']],
  peak: [['Mount {X}'], ['{X} Peak', '{X} Horn']],
  volcano: [['Mount {X}'], ['{X} Volcano']],
  'volcano:shield': [['Mount {X}'], ['{X} Shield']],
  caldera: [[], ['{X} Caldera']],
  crater: [[], ['{X} Crater']],
  plateau: [[], ['{X} Plateau', '{X} Tableland']],
  rift: [[], ['{X} Rift', '{X} Rift Valley']],
  'mesa-field': [[], ['{X} Mesas', '{X} Buttes']],
  canyon: [[], ['{X} Canyon']],
  'canyon:gorge': [[], ['{X} Gorge']],
  river: [['River {X}'], ['{X} River']],
  lake: [['Lake {X}'], ['{X} Lake', '{X} Water']],
  'lake:salt': [[], ['{X} Salt Lake']],
  'lake:playa': [[], ['{X} Salt Flat', '{X} Playa', '{X} Salt Pan']],
  'lake:crater': [['Lake {X}'], ['{X} Crater Lake']],
  waterfall: [[], ['{X} Falls']],
  delta: [[], ['{X} Delta']],
  fjord: [[], ['{X} Fjord', '{X}fjord']],
  glacier: [[], ['{X} Glacier']],
  icecap: [[], ['{X} Ice Cap', '{X} Ice Field']],
  'icecap:sheet': [[], ['{X} Ice Sheet']],
  desert: [[], ['{X} Desert']],
  'desert:polar': [[], ['{X} Barrens']],
  erg: [[], ['{X} Erg', '{X} Sand Sea']],
  forest: [[], ['{X} Forest', '{X} Woods']],
  'forest:taiga': [[], ['{X} Taiga', '{X} Forest']],
  'forest:jungle': [[], ['{X} Rainforest', '{X} Jungle']],
  'forest:wood': [[], ['{X} Wood', '{X} Woods', '{X} Grove']],
  wetland: [[], ['{X} Marshes']],
  'wetland:swamp': [[], ['{X} Swamp']],
  'wetland:fen': [[], ['{X} Fens', '{X} Fen']],
  'wetland:bog': [[], ['{X} Bogs', '{X} Moss']],
  'wetland:mangrove': [[], ['{X} Mangroves']],
  'wetland:saltmarsh': [[], ['{X} Salt Marshes']],
  'wetland:moss': [[], ['{X} Moss', '{X} Mire']],
  karst: [[], ['{X} Karst']],
  'karst:towers': [[], ['{X} Stone Forest', '{X} Towers']],
  reef: [[], ['{X} Reef']],
  atoll: [[], ['{X} Atoll']],
  plain: [[], ['{X} Plain', '{X} Plains']],
  'plain:lowlands': [[], ['{X} Lowlands']],
  'plain:uplands': [[], ['{X} Uplands']],
  'plateau:highlands': [[], ['{X} Highlands']],
  hill: [['Mount {X}'], ['{X} Hill', '{X} Knob', '{X} Fell']],
  'hill:rise': [[], ['{X} Rise', '{X} Knoll', '{X} Downs']],
  grassland: [[], ['{X} Steppe', '{X} Grasslands']],
  pass: [[], ['{X} Pass', '{X} Gap', '{X} Saddle']],
  gorge: [[], ['{X} Gorge', '{X} Narrows', '{X} Ravine']],
  'grassland:savanna': [[], ['{X} Savanna', '{X} Veld']],
  'grassland:scrub': [[], ['{X} Scrub', '{X} Bush', '{X} Scrubland']],
  'grassland:tundra': [[], ['{X} Tundra']],
};

const pick = <T>(rng: Rng, a: readonly T[]): T => a[rng.int(a.length)];

/** Consonant runs: at most two letters, or three when one of them is an 'h' digraph. */
function pronounceable(w: string): boolean {
  if (w.length < 3 || w.length > 11) return false;
  let run = 0;
  let runH = false;
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    if (VOWELS.has(ch)) {
      run = 0;
      runH = false;
      continue;
    }
    run++;
    if (ch === 'h' || ch === 'w') runH = true;
    if (run > 3 || (run === 3 && !runH)) return false;
    if (i >= 2 && w[i - 1] === ch && w[i - 2] === ch) return false;
  }
  for (let i = 2; i < w.length; i++) if (VOWELS.has(w[i]) && VOWELS.has(w[i - 1]) && VOWELS.has(w[i - 2])) return false;
  return true;
}

function word(lang: Language, rng: Rng, minSyl: number): string {
  for (let attempt = 0; attempt < 30; attempt++) {
    const nsyl = Math.max(minSyl, rng.float() < lang.p3 ? 3 : 2);
    let w = '';
    for (let i = 0; i < nsyl; i++) {
      const last = i === nsyl - 1;
      const onset = i === 0 && rng.float() < lang.vowelStart ? '' : pick(rng, lang.onsets);
      if (last && lang.endings.length && rng.float() < lang.endingP) {
        const e = pick(rng, lang.endings);
        w += VOWELS.has(e[0]) ? onset + e : e;
        continue;
      }
      const coda = rng.float() < (last ? lang.codaEnd : lang.codaMid) ? pick(rng, lang.codas) : '';
      w += onset + pick(rng, lang.nuclei) + coda;
    }
    if (pronounceable(w)) return w[0].toUpperCase() + w.slice(1);
  }
  return 'Ana';
}

export interface Culture {
  lang: number;
  /** Centre: map metres (spheres: encoded position, geo.ts). */
  x: number;
  y: number;
}

export class Namer {
  readonly cultures: Culture[];
  private readonly used = new Set<string>();
  private readonly bases = new Set<string>();

  /** Spheres: unit vectors of the culture centres (3 per culture). */
  private readonly dirs: Float64Array | null = null;
  private readonly geo: Geo | null;
  private readonly p = new Float64Array(3);

  constructor(private readonly seed: number, rng: Rng, worldM: number, geo?: Geo) {
    const k = 3 + rng.int(3);
    const ids = LANGUAGES.map((_, i) => i);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.cultures = [];
    this.geo = geo?.sphere ? geo : null;
    if (this.geo) {
      // Spheres: centres uniform on the planet; regions are the geodesic Voronoi cells.
      const g = this.geo;
      const dirs = new Float64Array(3 * k);
      for (let i = 0; i < k; i++) {
        const z = rng.range(-1, 1);
        const lon = rng.range(-Math.PI, Math.PI);
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        dirs.set([r * Math.cos(lon), r * Math.sin(lon), z], 3 * i);
        const [x, y] = g.fromDir(dirs[3 * i], dirs[3 * i + 1], dirs[3 * i + 2]);
        this.cultures.push({ lang: ids[i], x, y });
      }
      this.dirs = dirs;
      return;
    }
    for (let i = 0; i < k; i++) this.cultures.push({ lang: ids[i], x: rng.range(0.1, 0.9) * worldM, y: rng.range(0.1, 0.9) * worldM });
  }

  /** Language index of the culture region at a map position (spheres: nearest centre along the surface). */
  langAt(x: number, y: number): number {
    let best = 0;
    if (this.geo && this.dirs) {
      const p = this.p;
      const D = this.dirs;
      this.geo.dir(x, y, p);
      let bd = -Infinity;
      this.cultures.forEach((c, i) => {
        const d = p[0] * D[3 * i] + p[1] * D[3 * i + 1] + p[2] * D[3 * i + 2];
        if (d > bd) (bd = d), (best = c.lang);
      });
      return best;
    }
    let bd = Infinity;
    for (const c of this.cultures) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bd) (bd = d), (best = c.lang);
    }
    return best;
  }

  languageId(lang: number): string {
    return LANGUAGES[lang].id;
  }

  /**
   * A unique name for a landmark. `ident` is a stable identity hash; `base` reuses another
   * landmark's base word (a river's delta). Returns [full name, base word].
   */
  name(kind: LandmarkKind, variant: string | undefined, lang: number, ident: number, base?: string): [string, string] {
    const langDef = LANGUAGES[lang];
    const pat = PATTERNS[`${kind}:${variant}`] ?? PATTERNS[kind] ?? [[], ['{X}']];
    for (let attempt = 0; attempt < 40; attempt++) {
      const rng = rngFor(this.seed, 'name', lang, kind, ident, attempt);
      let b = base && attempt < 4 ? base : word(langDef, rng, kind === 'continent' ? 3 : 2);
      if (kind === 'continent' && !base && rng.float() < 0.5) {
        const suf = pick(rng, langDef.landSuffix);
        const stem = VOWELS.has(b[b.length - 1]) && VOWELS.has(suf[0]) ? b.slice(0, -1) : b;
        if (pronounceable((stem + suf).toLowerCase())) b = stem + suf;
      }
      if (!base || attempt >= 4) {
        if (this.bases.has(b)) continue;
      }
      const usePre = pat[0].length > 0 && (pat[1].length === 0 || rng.float() < langDef.preP);
      const list = usePre ? pat[0] : pat[1];
      // A language keeps its favourite generic for a kind most of the time.
      const fav = hashMix(hashString(kind, this.seed), lang) % list.length;
      const p = rng.float() < 0.7 ? list[fav] : pick(rng, list);
      const full = p.replace('{X}', b);
      if (this.used.has(full)) continue;
      this.used.add(full);
      this.bases.add(b);
      return [full, b];
    }
    // Practically unreachable: fall back to a numbered name.
    let i = 2;
    while (this.used.has(`${kind} ${i}`)) i++;
    const full = `${kind[0].toUpperCase()}${kind.slice(1)} ${i}`;
    this.used.add(full);
    return [full, full];
  }
}
