import type { FromWorker, ToWorker } from '../shared/protocol';
import { Pipeline } from './pipeline';
import { STAGES } from './stages';

/** Same request semantics as gen.worker.ts, on the calling thread (`?gen=main`). */
export function createInThreadRunner(emit: (msg: FromWorker) => void): (msg: ToWorker) => void {
  const pipeline = new Pipeline(STAGES);
  let latest = 0;
  let running: Promise<void> = Promise.resolve();
  return (msg) => {
    latest = msg.reqId;
    running = running.then(() =>
      msg.reqId === latest ? pipeline.run(msg.resolved, msg.mode, msg.reqId, emit, () => msg.reqId !== latest) : undefined,
    );
  };
}
