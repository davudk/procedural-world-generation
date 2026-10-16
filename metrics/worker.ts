/** Worker thread: measures one world per message (see runner.ts). */
import { parentPort } from 'node:worker_threads';
import { measureWorld, type WorldJob } from './world';

parentPort!.on('message', (msg) => {
  measureWorld(msg as WorldJob).then(
    (m) => parentPort!.postMessage({ ok: true, m }),
    (e: unknown) => parentPort!.postMessage({ ok: false, err: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
  );
});
