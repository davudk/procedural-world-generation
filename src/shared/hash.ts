import { Rng } from './rng';

/** murmur3 32-bit finalizer. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combines a 32-bit hash with another 32-bit value. */
export function hashMix(h: number, v: number): number {
  return fmix32((h ^ Math.imul(v >>> 0, 0x9e3779b1)) + 0x7f4a7c15);
}

export function hashString(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return fmix32(h);
}

/** Order-stable hash of JSON-like data (object keys are sorted). */
export function hashValue(v: unknown, h = 0x1234567): number {
  if (v === null || v === undefined) return hashMix(h, 0xdead);
  switch (typeof v) {
    case 'number': {
      if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) return hashMix(hashMix(h, 1), v);
      return hashString(String(v), hashMix(h, 2));
    }
    case 'string':
      return hashString(v, hashMix(h, 3));
    case 'boolean':
      return hashMix(hashMix(h, 4), v ? 1 : 0);
    case 'object': {
      if (Array.isArray(v)) {
        let x = hashMix(h, 5 + v.length);
        for (const e of v) x = hashValue(e, x);
        return x;
      }
      const o = v as Record<string, unknown>;
      let x = hashMix(h, 6);
      for (const k of Object.keys(o).sort()) x = hashValue(o[k], hashString(k, x));
      return x;
    }
    default:
      throw new Error(`hashValue: unsupported ${typeof v}`);
  }
}

/** FNV-style hash over the bytes of a typed array (for determinism tests). */
export function hashBytes(a: ArrayBufferView, h = 0x811c9dc5): number {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
  return fmix32(h);
}

/**
 * Independent seeded stream per (seed, keys…). Changing how one stage consumes randomness never
 * moves another stage's output (PLAN.md §11).
 */
export function rngFor(seed: number, ...keys: (string | number)[]): Rng {
  let h = fmix32(seed >>> 0);
  for (const k of keys) h = typeof k === 'number' ? hashMix(h, k) : hashString(k, h);
  return new Rng(h);
}
