import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

try {
  const module = await import(pathToFileURL(workerData as string).href);

  parentPort!.postMessage({ value: JSON.stringify(module.default) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error : new Error(String(error)) });
}
