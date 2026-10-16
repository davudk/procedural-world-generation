import './atlas.css';
import type { Landmark, LandmarkKind, WorldTraits } from '../shared/landmarks';

export interface AtlasCallbacks {
  /** User picked a landmark (fly there). */
  onSelect(l: Landmark): void;
  /** Pointer entered / left a landmark row (highlight its label). */
  onHover(l: Landmark | null): void;
}

/** Display order and plural group titles. */
const GROUPS: readonly [string, readonly LandmarkKind[]][] = [
  ['Mountains', ['range', 'peak', 'hill', 'pass', 'volcano', 'caldera', 'plateau', 'rift', 'canyon', 'gorge', 'mesa-field']],
  ['Rivers & lakes', ['river', 'lake', 'waterfall', 'delta']],
  ['Seas & coasts', ['ocean', 'sea', 'gulf', 'bay', 'strait', 'lagoon', 'fjord', 'reef', 'atoll']],
  ['Lands', ['continent', 'island', 'archipelago', 'peninsula', 'cape', 'isthmus', 'plain']],
  ['Ice, deserts & forests', ['icecap', 'glacier', 'desert', 'erg', 'forest', 'grassland', 'wetland', 'karst']],
  ['Impacts', ['crater']],
];

const KIND_LABEL: Readonly<Record<LandmarkKind, string>> = {
  continent: 'Continent', island: 'Island', archipelago: 'Archipelago', peninsula: 'Peninsula', cape: 'Cape', isthmus: 'Isthmus',
  ocean: 'Ocean', sea: 'Sea', gulf: 'Gulf', bay: 'Bay', strait: 'Strait', lagoon: 'Lagoon',
  range: 'Mountain range', peak: 'Peak', volcano: 'Volcano', caldera: 'Caldera', crater: 'Impact crater', plateau: 'Plateau',
  rift: 'Rift', 'mesa-field': 'Mesas', canyon: 'Canyon', river: 'River', lake: 'Lake', waterfall: 'Waterfall', delta: 'Delta',
  fjord: 'Fjord', glacier: 'Glacier', icecap: 'Ice cap', desert: 'Desert', erg: 'Sand sea', forest: 'Forest', wetland: 'Wetland',
  karst: 'Karst', reef: 'Reef', atoll: 'Atoll', plain: 'Plain', hill: 'Hill', grassland: 'Open country', pass: 'Pass', gorge: 'Gorge',
};

/** Rows shown per group before "show more". */
const PAGE = 12;

/**
 * Atlas panel (PLAN.md §10): World traits, hero landmarks, then every named landmark grouped by
 * kind and ordered by importance, with search. Rows fly the camera to the landmark.
 */
export class AtlasPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly search: HTMLInputElement;
  private landmarks: readonly Landmark[] = [];
  private traits: WorldTraits | null = null;
  private expanded = new Set<string>();

  constructor(parent: HTMLElement, private readonly cb: AtlasCallbacks) {
    this.el = document.createElement('aside');
    this.el.className = 'atlas hidden';
    const head = document.createElement('div');
    head.className = 'atlas-head';
    const title = document.createElement('span');
    title.className = 'atlas-title';
    title.textContent = 'Atlas';
    const close = document.createElement('button');
    close.className = 'atlas-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close atlas');
    close.addEventListener('click', () => this.toggle(false));
    head.append(title, close);
    this.search = document.createElement('input');
    this.search.className = 'atlas-search';
    this.search.type = 'search';
    this.search.placeholder = 'Search places…';
    this.search.addEventListener('input', () => this.render());
    this.body = document.createElement('div');
    this.body.className = 'atlas-body';
    this.el.append(head, this.search, this.body);
    parent.append(this.el);
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  toggle(show = !this.open): void {
    this.el.classList.toggle('hidden', !show);
  }

  set(landmarks: readonly Landmark[], traits: WorldTraits | null): void {
    this.landmarks = landmarks;
    this.traits = traits;
    this.render();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    const out: HTMLElement[] = [];
    const byId = new Map(this.landmarks.map((l) => [l.id, l]));
    if (!q && this.traits && this.traits.headline) {
      const t = document.createElement('section');
      t.className = 'atlas-traits';
      const h = document.createElement('p');
      h.className = 'atlas-headline';
      h.textContent = this.traits.headline;
      const ul = document.createElement('ul');
      for (const s of this.traits.traits) {
        const li = document.createElement('li');
        li.textContent = s;
        ul.append(li);
      }
      t.append(h, ul);
      out.push(t);
      const heroes = this.traits.heroes.map((id) => byId.get(id)).filter((l): l is Landmark => !!l);
      if (heroes.length) out.push(this.section('Highlights', heroes, true));
    }
    const match = (l: Landmark): boolean => !q || l.name.toLowerCase().includes(q) || KIND_LABEL[l.kind].toLowerCase().includes(q);
    for (const [title, kinds] of GROUPS) {
      const items = this.landmarks.filter((l) => kinds.includes(l.kind) && match(l)).sort((a, b) => b.importance - a.importance);
      if (items.length) out.push(this.section(title, items, false));
    }
    if (out.length === 0) {
      const p = document.createElement('p');
      p.className = 'atlas-empty';
      p.textContent = this.landmarks.length ? 'No matches.' : 'Landmarks appear when the world finishes generating.';
      out.push(p);
    }
    this.body.replaceChildren(...out);
  }

  private section(title: string, items: readonly Landmark[], hero: boolean): HTMLElement {
    const s = document.createElement('section');
    s.className = hero ? 'atlas-section atlas-heroes' : 'atlas-section';
    const h = document.createElement('h3');
    h.textContent = `${title} · ${items.length}`;
    s.append(h);
    const all = this.expanded.has(title) || this.search.value.trim() !== '';
    for (const l of all ? items : items.slice(0, PAGE)) s.append(this.row(l));
    if (!all && items.length > PAGE) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'atlas-more';
      more.textContent = `Show ${items.length - PAGE} more`;
      more.addEventListener('click', () => {
        this.expanded.add(title);
        this.render();
      });
      s.append(more);
    }
    return s;
  }

  private row(l: Landmark): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = l.hero ? 'atlas-row hero' : 'atlas-row';
    const name = document.createElement('span');
    name.className = 'atlas-name';
    name.textContent = l.name;
    const meta = document.createElement('span');
    meta.className = 'atlas-meta';
    meta.textContent = [KIND_LABEL[l.kind], fact(l)].filter(Boolean).join(' · ');
    b.append(name, meta);
    b.addEventListener('click', () => this.cb.onSelect(l));
    b.addEventListener('pointerenter', () => this.cb.onHover(l));
    b.addEventListener('pointerleave', () => this.cb.onHover(null));
    return b;
  }
}

/** The single most telling number for a landmark. */
export function fact(l: Landmark): string {
  const d = l.data;
  const km = (v: number): string => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 0 : 1));
  if (d.heightM !== undefined && (l.kind === 'peak' || l.kind === 'volcano' || l.kind === 'range' || l.kind === 'plateau')) {
    return `${Math.round(d.heightM).toLocaleString('en-US')} m`;
  }
  if (d.lengthKm !== undefined) return `${km(d.lengthKm)} km long`;
  if (d.areaKm2 !== undefined) return `${km(d.areaKm2)} km²`;
  if (d.depthM !== undefined) return `${Math.round(d.depthM)} m deep`;
  if (d.dropM !== undefined) return `${Math.round(d.dropM)} m drop`;
  if (d.diameterKm !== undefined) return `${km(d.diameterKm)} km across`;
  return l.extentM >= 1000 ? `${km(l.extentM / 1000)} km` : '';
}

export { KIND_LABEL };
