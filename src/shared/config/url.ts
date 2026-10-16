import { DEFAULT_ARCHETYPE, archetypeById } from './archetypes';
import { PARAM_BY_ID } from './schema';
import { AUTO_PIN, type Pin, type WorldSpec } from './types';

/**
 * URL form of a world: `?seed=42&a=fjordland&worldSize=2048&plateCount=4~6&continentCount=~3&fjords=1`.
 * Only the seed, archetype and user pins are stored; AUTO values are re-derived (CONFIG.md §6), so links
 * stay short and keep working when AUTO formulas change. Unknown keys are ignored.
 */
export function specToQuery(spec: WorldSpec): string {
  const q = new URLSearchParams();
  q.set('seed', String(spec.seed >>> 0));
  if (spec.archetype !== DEFAULT_ARCHETYPE) q.set('a', spec.archetype);
  for (const id of Object.keys(spec.pins).sort()) {
    const p = spec.pins[id];
    q.set(id, encodePin(p));
  }
  return q.toString();
}

export function queryToSpec(query: string, fallbackSeed: number): WorldSpec {
  const q = new URLSearchParams(query);
  const seedStr = q.get('seed');
  const seed = seedStr !== null && /^\d+$/.test(seedStr) ? Number(seedStr) >>> 0 : fallbackSeed >>> 0;
  const archetype = archetypeById(q.get('a') ?? DEFAULT_ARCHETYPE).id;
  const pins: Record<string, Pin> = {};
  for (const [key, raw] of q) {
    const d = PARAM_BY_ID.get(key);
    if (!d || d.readonly) continue;
    const pin = decodePin(d.kind, raw);
    if (pin !== undefined) pins[key] = pin;
  }
  return { seed, archetype, pins };
}

function encodePin(p: Pin): string {
  if (Array.isArray(p)) return `${p[0] ?? ''}~${p[1] ?? ''}`;
  if (typeof p === 'boolean') return p ? '1' : '0';
  return String(p);
}

function decodePin(kind: string, raw: string): Pin | undefined {
  if (raw === AUTO_PIN) return AUTO_PIN;
  const n = (s: string): number | null => (s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null);
  switch (kind) {
    case 'number': {
      const v = n(raw);
      return v === null ? undefined : v;
    }
    case 'toggle':
      return raw === '1' ? true : raw === '0' ? false : undefined;
    case 'enum':
      return raw;
    default: {
      const parts = raw.split('~');
      if (parts.length !== 2) return undefined;
      const lo = n(parts[0]);
      const hi = n(parts[1]);
      return lo === null && hi === null ? undefined : [lo, hi];
    }
  }
}
