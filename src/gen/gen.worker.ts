/// <reference lib="webworker" />
import { transferablesOf, type FromWorker, type ToWorker } from '../shared/protocol';
import { Pipeline } from './pipeline';
import { STAGES } from './stages';

declare const self: DedicatedWorkerGlobalScope;

const pipeline = new Pipeline(STAGES);
let latest = 0;
let running: Promise<void> = Promise.resolve();

const emit = (msg: FromWorker): void => self.postMessage(msg, transferablesOf(msg));

self.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data;
  if (msg.type !== 'generate') return;
  latest = msg.reqId;
  // Requests run one after another; a newer request makes the running one cancel at its next checkpoint.
  running = running.then(() =>
    msg.reqId === latest
      ? pipeline.run(msg.resolved, msg.mode, msg.reqId, emit, () => msg.reqId !== latest)
      : emit({ type: 'cancelled', reqId: msg.reqId }),
  );
};
