# V8 Maglev: objects rebuilt at one deopt point share number boxes

**Status:** worked around in the landmark registry (`src/gen/registry/candidate.ts`). Not reported upstream.

**Environment:** Node 24.21.0 (V8 13.6.233.17-node.53), macOS arm64. Chrome uses the same Maglev tier, so the shipped app is exposed too.

## Symptom

- Landmark hashes were nondeterministic from one process to the next (the golden test failed in about 5 of 12 runs under load).
- The failing world was earth, seed 11, preview, run after earth seed 7 (preview and 512 km build), as in the golden matrix.
- The world's one gulf (`Dugrar Gulf`, 10 368 km², at 594/338 km) kept its kind and `data`, but its `x`, `y`, `extentM`, `mag`, `idX` and `idY` became those of a 224 km² bay at 378/214 km.
  - That bay came from the second `embayments()` call (the bays), after the gulf call had returned.
  - The new id position renamed it, and the smaller extent dropped it from rank 13 to 46.
- With `--no-maglev`: 0 failures. Running the world on its own, or re-running the registry in one thread, never failed: it needs a fresh isolate with that tiering history.

## Evidence

- **No JS writes these fields.** Nothing in `src/` assigns `x`, `y`, `extentM`, `mag`, `idX` or `idY` of a candidate, and nothing uses `Object.assign` on one.
- **The gulf and the bay hold the same HeapNumbers.** `%DebugPrint` at the end of a failing run (`--allow-natives-syntax`) shows both objects' number fields pointing at the same HeapNumber addresses. These are mutated in place.
- **The boxes come from the deopt data.** `--trace-deopt-verbose` shows `embayments` Maglev OSR code deopting twice, once in each call, at the same exit (`water.ts:210`, bytecode 1416).
  - The reason was "Insufficient type feedback for generic named access" on the literal's first `DefineNamedOwnProperty` (`kind`).
  - That is right after `CreateObjectLiteral`, before any field is stored.
  - The escape-analysed literal is a captured object whose number fields are the deopt literals `<HeapNumber nan>`, a distinct one per field.
  - These are the very boxes both materialised objects ended up holding.
- **Reading of the mechanism:**
  - The deoptimizer builds each object rebuilt at that exit from the same template boxes.
  - The interpreter resumes and stores each field into its box in place, since the field representation is Double.
  - So every object rebuilt there aliases the others, and the last one stored wins.
  - In a correct translation, double fields are separate captured HeapNumbers with fresh boxes. A small literal with Double fields gets exactly that (see the attempts below), so this exit hit a path that embedded the boxes as constants.
- **It is not a comparator or a scratch buffer.** All 18 golden worlds were run with every `sort` comparator wrapped: 3.4 M calls gave no NaN results and no antisymmetry violations. No module-level scratch is shared between calls.

## Reproducing

- `npm run jit-stress -- --runs 400 --workers 8` runs the stress harness:
  1. It generates earth 7 preview, earth 7 build512 and earth 11 preview once.
  2. It then re-runs only the registry over them in fresh worker isolates and compares the landmark hashes with the main thread's.
- Before the fix, 7 of 400 and 14 of 800 isolates differed, always earth 11 preview with the gulf above. With 4 workers at a time it was rarer (0 of 200).
- After the fix: 0 of 1 000.
- `--stress-maglev` and `--no-concurrent-recompilation` did not make it fail reliably (0 of 160 isolates each, too few to tell them from the default).
- **Standalone repro: not achieved.** Attempts (hot loop to OSR, then a literal whose stores lack feedback; Smi→Double and Double→Tagged generalisations of the shared map; warm-ups that throw before the stores) deopt at the same point. But they capture fresh HeapNumber objects, as a correct translation should. The registry's literal shape is shared by about 40 sites with mixed field representations, and that churn seems to be the missing ingredient.

## Workaround

- Every registry candidate is built as `candidate({ ... })`, and every landmark is pushed as `own(lm)`. Hero records assigned later are wrapped in `own(...)`.
- `own` copies a record into an empty object one property at a time. Adding a property always allocates a new box, so the copy shares nothing. The literal itself may still be overwritten later, but nothing keeps it.
- `tests/jitDeterminism.test.ts` checks this in three ways:
  - It lints that the wrapping stays.
  - It re-runs the registry in-thread.
  - It runs 32 fresh isolates after the warm-up; before the fix, about 40 % of such runs would have caught the bug.
- The golden test runs with Maglev again, in the normal vitest project.

## Exposure elsewhere

The pattern is general. It needs an object literal with number fields, created in optimized code that can deopt before its stores, and kept beyond the next time that code deopts at the same point. Other long-lived records with number fields are still built as plain literals:
- landform features (`landforms/**`, read by the registry);
- lake records (`hydro/depressions.ts`);
- plate boundary segments.

None of them has been seen to diverge. The golden test (now run with Maglev) and `jit-stress` would show it if one did, and the same `own()` copy would fix it.
