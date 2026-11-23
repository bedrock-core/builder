import { Worker } from 'node:worker_threads';
import type { UiEnvironment, UiRequest } from './types.ts';

/** Bound module memory while evaluating screens against one shared toolkit bundle. */
export class UiEvaluator {
  private _worker?: Worker;
  private _count = 0;
  private _pending = false;
  private readonly _environment: UiEnvironment;
  private readonly _signal?: AbortSignal;

  /** Configure the shared toolkit bundle and cooperative cancellation for worker requests. */
  constructor(environment: UiEnvironment, signal?: AbortSignal) {
    this._environment = environment;
    this._signal = signal;
  }

  /**
   * Evaluate one operation and receive its structured result. Calls must be sequential.
   * @param message Export discovery, screen compilation or complete-set linking request.
   * @returns The worker's portable result, typed by the caller.
   * @throws If another request is pending, evaluation fails or cancellation occurs.
   */
  async request<T>(message: UiRequest): Promise<T> {
    this._signal?.throwIfAborted();

    if (this._pending) {
      throw new Error('UI compilation is sequential');
    }

    if (this._count >= 64) {
      await this.close();
    }

    this._pending = true;
    const worker = this._worker ??= new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url), {
      workerData: this._environment,
      ...(process.execArgv.some(argument => argument.startsWith('--input-type')) ? { execArgv: [] } : {}),
    });

    try {
      return await new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', receive);
          worker.off('error', fail);
          worker.off('exit', exited);
          this._signal?.removeEventListener('abort', abort);
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
          fail(this._signal!.reason);
        };

        worker.once('message', receive);
        worker.once('error', fail);
        worker.once('exit', exited);
        this._signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage(message);
      });
    } finally {
      this._count++;
      this._pending = false;
    }
  }

  /** Terminate the active worker and reset its module lifetime; call in a finally block. */
  async close(): Promise<void> {
    const worker = this._worker;

    this._worker = undefined;
    this._count = 0;
    await worker?.terminate();
  }
}
