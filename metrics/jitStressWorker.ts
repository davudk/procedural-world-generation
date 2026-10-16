/** Worker thread for jitStress.ts: runs the registry over the posted worlds once, in a fresh isolate. */
import { parentPort, workerData } from 'node:worker_threads';
import { registryHashes, type PreparedWorld } from './jitStress';

registryHashes(workerData as PreparedWorld[]).then(
  (hashes) => parentPort!.postMessage({ ok: true, hashes }),
  (e: unknown) => parentPort!.postMessage({ ok: false, err: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
);
