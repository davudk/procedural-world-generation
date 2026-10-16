import type { Candidate } from './types';

/**
 * A copy of a plain record, built by adding its own properties one at a time to an empty object, so
 * every number field gets a box of its own.
 *
 * Works around a V8 Maglev bug (docs/notes/v8-maglev-shared-number-boxes.md): when optimized code
 * deoptimizes between allocating an object literal and storing its fields, the deoptimizer can give
 * the rebuilt object the literal's template number boxes, and the interpreter then writes the field
 * values into those boxes in place. Every object rebuilt at that deopt point shares them, so a later
 * one silently overwrites an earlier one's numbers (a retained gulf took the position and size of a
 * bay from the next call). A record copied right after its literal is complete keeps the values it
 * was built with whatever happens to the literal afterwards.
 */
export function own<T extends object>(o: T): T {
  const src = o as Record<string, unknown>;
  const c: Record<string, unknown> = {};
  for (const k of Object.keys(src)) c[k] = src[k];
  return c as T;
}

/** A detector's candidate as records of its own (`own`, with its `data` and `hero` copied too). */
export function candidate(c: Candidate): Candidate {
  const o = own(c);
  o.data = own(c.data);
  if (c.hero) o.hero = own(c.hero);
  return o;
}
