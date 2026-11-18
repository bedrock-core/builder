import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

function field(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);

  return buffer.toString('utf8', offset, end < 0 || end > offset + length ? offset + length : end);
}

/** Read regular files from an npm tarball without extracting links or executing package code. */
export function extractTgz(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    if (header.every(byte => byte === 0)) {
      break;
    }

    const size = Number.parseInt(field(header, 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const start = offset + BLOCK;
    const end = start + size;
    const prefix = field(header, 345, 155);
    let name = longName ?? field(header, 0, 100);

    longName = undefined;

    if (size < 0 || end > tar.length) {
      throw new Error('Truncated npm schema tarball');
    }

    if (prefix && !name.startsWith(prefix)) {
      name = `${prefix}/${name}`;
    }

    if (type === 'L') {
      longName = tar.toString('utf8', start, end).replace(/\0+$/, '');
    } else if (type === '0' || type === '\0') {
      files.set(name.replaceAll('\\', '/'), tar.subarray(start, end));
    }

    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
}
