import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { exists, hash } from '../files.ts';

export interface MetadataSource {
  url: string;
  sha256: string;
  componentVersion: string;
}

interface Entry {
  fileName: string;
  uncompressedSize: number;
  generalPurposeBitFlag: number;
  externalFileAttributes: number;
}

interface Archive {
  on(event: string, callback: (...args: never[]) => void): void;
  readEntry(): void;
  close(): void;
  openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void;
}
const zip: { open(file: string, options: object, callback: (error: Error | null, archive: Archive) => void): void } = createRequire(
  import.meta.url,
)('yauzl');

/** Open the release archive only after verifying its pinned bytes. */
export async function sampleArchive(source: MetadataSource, cache: string, supplied?: string): Promise<string> {
  const cached = path.join(cache, source.sha256 + '.zip');
  let bytes: Buffer;

  if (supplied || (await exists(cached))) {
    bytes = await readFile(supplied ?? cached);
  } else {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(60000) });

    if (!response.ok) {
      throw new Error('Native schema archive returned HTTP ' + response.status);
    }

    const chunks: Uint8Array[] = [];
    let length = 0;

    for await (const chunk of response.body!) {
      length += chunk.length;

      if (length > 256 * 1024 * 1024) {
        throw new Error('Schema archive exceeds 256 MiB');
      }

      chunks.push(chunk);
    }

    bytes = Buffer.concat(chunks);
  }

  if (hash(bytes) !== source.sha256) {
    throw new Error('Native schema archive hash mismatch');
  }

  await mkdir(cache, { recursive: true });

  if (!(await exists(cached))) {
    const temporary = path.join(cache, randomUUID() + '.zip');

    try {
      await writeFile(temporary, bytes);
      await rename(temporary, cached);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return supplied ?? cached;
}

export async function readSampleEntries(
  file: string,
  select: (name: string) => boolean,
  read: (name: string, bytes: Buffer) => void | Promise<void>,
): Promise<void> {
  const archive = await new Promise<Archive>((resolve, reject) =>
    zip.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const names = new Set<string>();
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      archive.close();
      reject(error);
    };

    archive.on('error', fail);
    archive.on('end', resolve);
    archive.on('entry', (entry: Entry) => {
      void (async () => {
        if (entry.fileName.endsWith('/') || !select(entry.fileName)) {
          archive.readEntry();

          return;
        }

        const name = entry.fileName;

        if (
          /[\\:*?"<>|]/.test(name)
          || name.split('/').some(part => !part || part === '.' || part === '..')
          || entry.generalPurposeBitFlag & 1
          || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
          || entry.uncompressedSize > 32 * 1024 * 1024
          || names.has(name)
          || names.size >= 40000
        ) {
          throw new Error('Invalid Mojang sample archive member: ' + name);
        }

        names.add(name);
        const stream = await new Promise<Readable>((resolve, reject) =>
          archive.openReadStream(entry, (error, value) => (error ? reject(error) : resolve(value))),
        );
        const chunks: Buffer[] = [];
        let size = 0;

        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);

          size += bytes.length;
          total += bytes.length;

          if (size > entry.uncompressedSize || total > 1024 * 1024 * 1024) {
            throw new Error('Mojang sample archive exceeds its size limit');
          }

          chunks.push(bytes);
        }

        if (size !== entry.uncompressedSize) {
          throw new Error('Mojang sample archive member length mismatch');
        }

        await read(name, Buffer.concat(chunks));
        archive.readEntry();
      })().catch(fail);
    });
    archive.readEntry();
  });
}

/** Read only schema JSON from a verified Mojang release archive. */
export async function metadataSchemas(source: MetadataSource, cache: string, supplied?: string): Promise<Map<string, unknown>> {
  const file = await sampleArchive(source, cache, supplied);
  const prefix = 'metadata/json_schemas/';
  const result = new Map<string, unknown>();

  await readSampleEntries(file, name => name.startsWith(prefix) && name.endsWith('.json'), (name, bytes) => {
    result.set(name.slice(prefix.length), JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
  });

  if (!result.size) {
    throw new Error('Native schema archive contains no schema definitions');
  }

  return result;
}
