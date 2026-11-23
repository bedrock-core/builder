import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface InputFile { url: string; sha256: string }
const pending = new Map<string, Promise<Buffer>>();

/** Download data only, verify its pin before use, and retain it for reproducible offline maintenance. */
async function acquire(source: InputFile, cache: string, { offline = false, extension = '', maxBytes = 32 * 1024 * 1024 } = {}): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !source.url?.startsWith('https://')) {
    throw new Error('Invalid source pin');
  }

  const file = join(cache, source.sha256 + extension);
  let bytes = await readFile(file).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return undefined;
  });
  const downloaded = !bytes;

  if (!bytes) {
    if (offline) {
      throw new Error(`Pinned input missing from cache: ${source.url}`);
    }

    const response = await fetch(source.url, { signal: AbortSignal.timeout(60000) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${source.url}`);
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    for await (const chunk of response.body!) {
      size += chunk.length;

      if (size > maxBytes) {
        throw new Error('Pinned input exceeds its size limit');
      }

      chunks.push(chunk);
    }

    bytes = Buffer.concat(chunks);
  }

  if (bytes.length > maxBytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
    throw new Error(`Source hash or size mismatch: ${source.url}`);
  }

  if (downloaded) {
    await mkdir(cache, { recursive: true });

    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';

    await writeFile(temporary, bytes);
    await rename(temporary, file);
  }

  return bytes;
}

/** Coalesce identical acquisitions and expose only fully verified cache files. */
export async function lockedInput(source: InputFile, cache: string, options: Parameters<typeof acquire>[2] = {}): Promise<Buffer> {
  const key = JSON.stringify([source, cache, options]);
  let request = pending.get(key);

  if (!request) {
    request = acquire(source, cache, options);
    pending.set(key, request);
  }

  try {
    return await request;
  } finally {
    if (pending.get(key) === request) {
      pending.delete(key);
    }
  }
}
