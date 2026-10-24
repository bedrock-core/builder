import { Worker } from 'node:worker_threads';
import type { UiEnvironment, UiRequest } from './types.ts';

/** Bound module memory while evaluating screens against one shared toolkit bundle. */
export class UiEvaluator {
  private worker?: Worker;
  private count = 0;
  private pending = false;
  private readonly environment: UiEnvironment;
  private readonly signal?: AbortSignal;

  /** Configure the shared toolkit bundle and cooperative cancellation for worker requests. */
  constructor(environment: UiEnvironment, signal?: AbortSignal) {
    this.environment = environment;
    this.signal = signal;
  }

  /**
   * Evaluate one operation and receive its structured result. Calls must be sequential.
   * @param message Export discovery, screen compilation or complete-set linking request.
   * @returns The worker's portable result, typed by the caller.
   * @throws If another request is pending, evaluation fails or cancellation occurs.
   */
  async request<T>(message: UiRequest): Promise<T> {
    this.signal?.throwIfAborted();

    if (this.pending) {
      throw new Error('UI compilation is sequential');
    }

    if (this.count >= 64) {
      await this.close();
    }

    this.pending = true;
    const worker = this.worker ??= new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url), {
      workerData: this.environment,
      ...(process.execArgv.some(argument => argument.startsWith('--input-type')) ? { execArgv: [] } : {}),
    });

    try {
      return await new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', receive);
          worker.off('error', fail);
          worker.off('exit', exited);
          this.signal?.removeEventListener('abort', abort);
        };

        const receive = (response: { value?: unknown; error?: Error }) => {
          cleanup();

          if (response.error) {
            reject(response.error);
          } else {
            resolve(response.value as T);
          }
        };

        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };

        const exited = (code: number) => fail(new Error(`UI worker exited before returning a result (${code})`));

        const abort = () => {
          void worker.terminate();
          fail(this.signal!.reason);
        };

        worker.once('message', receive);
        worker.once('error', fail);
        worker.once('exit', exited);
        this.signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage(message);
      });
    } finally {
      this.count++;
      this.pending = false;
    }
  }

  /** Terminate the active worker and reset its module lifetime; call in a finally block. */
  async close(): Promise<void> {
    const worker = this.worker;

    this.worker = undefined;
    this.count = 0;
    await worker?.terminate();
  }
}
