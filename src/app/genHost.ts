import type { Resolved } from '../shared/config/types';
import type { FromWorker, GenMode, ToWorker } from '../shared/protocol';

/**
 * Runs generation in a Web Worker (or on the main thread with `?gen=main`, for breakpoints).
 * Only events of the latest request are delivered.
 */
export class GenHost {
  private reqId = 0;
  private worker: Worker | null = null;
  private mainPipeline: Promise<(msg: ToWorker) => void> | null = null;

  constructor(private readonly onEvent: (msg: FromWorker) => void) {
    if (new URLSearchParams(location.search).get('gen') === 'main') {
      this.mainPipeline = import('../gen/inThread').then((m) => m.createInThreadRunner((msg) => this.deliver(msg)));
    } else {
      this.worker = new Worker(new URL('../gen/gen.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.deliver(e.data);
      this.worker.onerror = (e) => this.onEvent({ type: 'error', reqId: this.reqId, message: e.message });
    }
  }

  generate(resolved: Resolved, mode: GenMode): number {
    const msg: ToWorker = { type: 'generate', reqId: ++this.reqId, resolved, mode };
    if (this.worker) this.worker.postMessage(msg);
    else void this.mainPipeline!.then((run) => run(msg));
    return msg.reqId;
  }

  private deliver(msg: FromWorker): void {
    if (msg.reqId === this.reqId) this.onEvent(msg);
  }
}
