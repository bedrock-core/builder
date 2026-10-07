import { Worker } from 'node:worker_threads';

export interface DeclaredApp {
  name: string;
  compiled: string;
  declared: Record<string, unknown>;
}

export interface DeclarationResult {
  declaration?: Record<string, unknown>;
  failure?: string;
}

/** Evaluate fresh in isolation; a registration may contain runtime side effects. */
export async function readUiDeclaration(module: string, signal?: AbortSignal): Promise<DeclarationResult> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./declaration-worker.ts', import.meta.url), {
    workerData: module,
    ...(process.execArgv.some(argument => argument.startsWith('--input-type')) ? { execArgv: [] } : {}),
  });

  try {
    return await new Promise<DeclarationResult>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      const cleanup = () => signal?.removeEventListener('abort', abort);

      worker.once('message', (response: { value?: string; error?: Error }) => {
        cleanup();

        if (response.error) {
          reject(response.error);
        } else {
          try {
            resolve(JSON.parse(response.value!) as DeclarationResult);
          } catch (error) {
            reject(error);
          }
        }
      });
      worker.once('error', (error) => {
        cleanup();
        reject(error);
      });
      worker.once('exit', (code) => {
        cleanup();
        reject(new Error(`UI declaration worker exited before returning a result (${code})`));
      });
      signal?.addEventListener('abort', abort, { once: true });
    });
  } finally {
    await worker.terminate();
  }
}

export function declaredApps(declaration: Record<string, unknown>): DeclaredApp[] {
  const apps = new Map<string, DeclaredApp>();

  for (const value of Object.values(declaration)) {
    if (value && typeof value === 'object' && 'app' in value && typeof value.app === 'string'
      && 'compiled' in value && typeof value.compiled === 'string') {
      apps.set(value.app, { name: value.app, compiled: value.compiled, declared: value as Record<string, unknown> });
    }
  }

  return [...apps.values()];
}

/** App modules own their shape function and receive only declared data. */
export function declaredScreens(apps: DeclaredApp[], declaration: Record<string, unknown>): string {
  const fields = { ...declaration, ...(declaration.manifest as object | undefined) };
  const manifest = Object.fromEntries(['creator', 'pack', 'packName', 'version', 'creatorName', 'description', 'icon', 'thumbnail']
    .flatMap(name => fields[name] === undefined ? [] : [[name, fields[name]]]));

  return [
    ...apps.map((app, index) => `import * as App${index} from ${JSON.stringify(app.compiled)};`),
    `const manifest = ${JSON.stringify(manifest)};`,
    'export default {',
    ...apps.map((app, index) => `  ...App${index}.shape?.(${JSON.stringify(app.declared)}, manifest),`),
    '};', '',
  ].join('\n');
}
