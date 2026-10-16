/**
 * Golden hashes (research 10 §8, Phase 1): per-stage, per-layer and per-vector hashes of a fixed
 * seed × archetype × mode matrix, recorded from the code before the Grid refactor. The determinism
 * tests elsewhere compare two runs of the current code; these catch a refactor that changes
 * outputs consistently. Re-record only for an intended output change:
 *
 *   GOLDEN_UPDATE=1 npx vitest run tests/golden.test.ts
 *
 * Spherical worlds (research 10 §8, Phase 2) have their own fixture, recorded when the sphere stages
 * landed; re-record only those with
 *
 *   GOLDEN_UPDATE=1 npx vitest run --project golden -t sphere
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { resolve } from '../src/shared/config/resolve';
import type { Pins } from '../src/shared/config/types';
import { hashBytes, hashValue } from '../src/shared/hash';
import type { GenMode, Vectors } from '../src/shared/protocol';

const FIXTURE = new URL('./golden.json', import.meta.url);
const SPHERE_FIXTURE = new URL('./golden-sphere.json', import.meta.url);
const UPDATE = process.env.GOLDEN_UPDATE === '1';

interface Case {
  name: string;
  seed: number;
  archetype: string;
  mode: GenMode;
  pins: Pins;
}

// Build mode on a 512 km world with reduced grids (LEM 256², macro 512²: still 1 km cells, and refine
// still upsamples by 2), so the whole matrix runs in well under a minute.
const BUILD_PINS: Pins = { worldSize: 512, lemGrid: '256', macroGrid: '512' };
const CASES: Case[] = [];
for (const archetype of ['earth', 'fjordland', 'desert']) {
  for (const seed of [7, 11, 42]) {
    CASES.push({ name: `${archetype}-${seed}-preview`, seed, archetype, mode: 'preview', pins: {} });
    CASES.push({ name: `${archetype}-${seed}-build512`, seed, archetype, mode: 'build', pins: BUILD_PINS });
  }
}
// Spheres: previews of the default small planet (6 × 128² erosion grid), plus one fjordland world.
const SPHERE_CASES: Case[] = [
  ...[7, 11, 42].map((seed) => ({ name: `sphere-earth-${seed}-preview`, seed, archetype: 'earth', mode: 'preview' as const, pins: { worldShape: 'sphere' } })),
  { name: 'sphere-fjordland-7-preview', seed: 7, archetype: 'fjordland', mode: 'preview', pins: { worldShape: 'sphere' } },
];

/** Wall-clock stats (`ms`, `ms_route`, `coastal_ms`, `carveMs`, …) are not outputs. */
const TIMING = /^ms$|^ms_|_ms$|_ms_|Ms$/;

/** hashValue, with typed arrays hashed by their bytes (and their type, so a Float32 → Float64 change shows). */
function hashAny(v: unknown, h = 0x2545f491): number {
  if (ArrayBuffer.isView(v)) return hashBytes(v, hashValue(v.constructor.name, h));
  if (Array.isArray(v)) {
    let x = hashValue(v.length, h);
    for (const e of v) x = hashAny(e, x);
    return x;
  }
  if (v !== null && typeof v === 'object') {
    let x = hashValue('{}', h);
    for (const k of Object.keys(v).sort()) x = hashAny((v as Record<string, unknown>)[k], hashValue(k, x));
    return x;
  }
  return hashValue(v, h);
}

function hashVectors(v: Vectors, out: Record<string, number>, prefix: string): void {
  if (v.rivers) for (const [k, a] of Object.entries(v.rivers)) out[`${prefix}.rivers.${k}`] = hashAny(a);
  if (v.lakes) out[`${prefix}.lakes`] = hashAny(v.lakes);
  if (v.landmarks) out[`${prefix}.landmarks`] = hashAny(v.landmarks);
  if (v.traits) out[`${prefix}.traits`] = hashAny(v.traits);
}

async function hashesOf(c: Case): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let err = '';
  const p = new Pipeline(STAGES);
  await p.run(resolve({ seed: c.seed, archetype: c.archetype, pins: c.pins }), c.mode, 1, (m) => {
    if (m.type === 'error') err = m.message;
    if (m.type !== 'stage-done') return;
    const s = m.stage;
    out[`${s}.stats`] = hashAny(Object.fromEntries(Object.entries(m.stats).filter(([k]) => !TIMING.test(k))));
    out[`${s}.outcomes`] = hashAny(m.outcomes);
    for (const l of m.layers) {
      const { data, ...header } = l;
      out[`${s}.layer.${l.id}`] = hashAny(data);
      out[`${s}.layer.${l.id}.header`] = hashAny(header);
    }
    if (m.vectors) hashVectors(m.vectors, out, `${s}.vectors`);
  }, () => false);
  if (err) throw new Error(err);
  // Stage-private rasters (read by later stages and by the metrics harness).
  for (const s of STAGES) {
    const extra = p.output(s.id)?.extra;
    if (extra === null || typeof extra !== 'object') continue;
    for (const [k, v] of Object.entries(extra)) if (ArrayBuffer.isView(v)) out[`${s.id}.extra.${k}`] = hashAny(v);
  }
  return out;
}

function goldenSuite(title: string, fixture: URL, cases: readonly Case[]): void {
  describe(title, () => {
    const recorded: Record<string, Record<string, number>> = existsSync(fixture) && !UPDATE ? JSON.parse(readFileSync(fixture, 'utf8')) : {};
    const fresh: Record<string, Record<string, number>> = {};

    for (const c of cases) {
      it(`${c.name} matches the recorded outputs`, async () => {
        const got = await hashesOf(c);
        fresh[c.name] = got;
        if (UPDATE) {
          if (Object.keys(fresh).length === cases.length) writeFileSync(fixture, JSON.stringify(fresh, null, 1) + '\n');
          return;
        }
        expect(recorded[c.name], `no recorded hashes for ${c.name}; run with GOLDEN_UPDATE=1`).toBeDefined();
        expect(got).toEqual(recorded[c.name]);
      }, 60_000);
    }
  });
}

goldenSuite('golden hashes', FIXTURE, CASES);
goldenSuite('sphere golden hashes', SPHERE_FIXTURE, SPHERE_CASES);
