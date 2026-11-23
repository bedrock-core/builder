import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

function field(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);

  return buffer.toString('utf8', offset, end < 0 || end > offset + length ? offset + length : end);
}

function paxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;

  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const length = Number(bytes.toString('ascii', offset, space));
    const end = offset + length;

    if (space <= offset || !Number.isSafeInteger(length) || end <= space + 1 || end > bytes.length || bytes[end - 1] !== 0x0a) {
      throw new Error('Invalid npm tarball extended header');
    }

    const record = bytes.toString('utf8', space + 1, end - 1);

    if (record.startsWith('path=')) {
      path = record.slice('path='.length);
    }

    offset = end;
  }

  return path;
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

    if (size < 0 || end > tar.length) {
      throw new Error('Truncated npm schema tarball');
    }

    if (!longName && prefix && !name.startsWith(prefix)) {
      name = `${prefix}/${name}`;
    }

    longName = undefined;

    if (type === 'L') {
      longName = tar.toString('utf8', start, end).replace(/\0+$/, '');
    } else if (type === 'x') {
      longName = paxPath(tar.subarray(start, end));
    } else if (type === '0' || type === '\0') {
      files.set(name.replaceAll('\\', '/'), tar.subarray(start, end));
    }

    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
}
