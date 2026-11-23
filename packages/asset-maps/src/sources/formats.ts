import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import type { RenderMaterial } from '../compiler/types.ts';

/** Index bounded members without extracting archive paths to disk. */
export function zipFiles(bytes: Buffer): Map<string, () => Buffer> {
  let end = bytes.length - 22;

  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) {
    end--;
  }

  if (end < 0) {
    throw new Error('Missing ZIP directory');
  }

  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map<string, () => Buffer>();

  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP directory');
    }

    const size = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24), length = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42), file = bytes.toString('utf8', offset + 46, offset + 46 + length), method = bytes.readUInt16LE(offset + 10), flags = bytes.readUInt16LE(offset + 8);

    if (files.has(file)) {
      throw new Error(`Duplicate ZIP entry: ${file}`);
    }

    files.set(file, () => {
      if (flags & 1 || expanded > 32 * 1024 * 1024 || bytes.readUInt32LE(local) !== 0x04034b50) {
        throw new Error('Unsupported ZIP entry');
      }

      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const payload = bytes.subarray(start, start + size);
      const result = method === 0 ? payload : method === 8 ? inflateRawSync(payload, { maxOutputLength: 32 * 1024 * 1024 }) : undefined;

      if (!result || result.length !== expanded) {
        throw new Error('Unsupported ZIP compression or length');
      }

      return result;
    });

    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }

  return files;
}

/** Read one named member; never extract archive paths to disk. */
export function zipEntry(bytes: Buffer, name: string): Buffer {
  const read = zipFiles(bytes).get(name);

  if (!read) {
    throw new Error(`Missing ZIP entry: ${name}`);
  }

  return read();
}

export interface ImageAlpha { width: number; height: number; alpha: Uint8Array }

export interface ImagePixels { width: number; height: number; rgba: Uint8Array }

export function pngPixels(bytes: Buffer): ImagePixels {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Unsupported texture format');
  }

  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], type = bytes[25];
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];

  if (!channels || bytes[28] > 1 || !width || !height || ![1, 2, 4, 8].includes(depth) || (depth !== 8 && type !== 3 && type !== 0) || width * height > 16777216) {
    throw new Error('Unsupported PNG layout');
  }

  const chunks: Buffer[] = [];
  let transparency: Buffer | undefined;
  let palette: Buffer | undefined;

  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, offset + 8 + length);

    if (offset + 12 + length > bytes.length) {
      throw new Error('Invalid PNG chunk');
    }

    if (kind === 'IDAT') {
      chunks.push(data);
    }

    if (kind === 'tRNS') {
      transparency = data;
    }

    if (kind === 'PLTE') {
      palette = data;
    }

    offset += 12 + length;
  }

  const layouts = bytes[28] ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const passes = layouts.map(([x, y, dx, dy]) => ({ x, y, dx, dy, width: Math.max(0, Math.ceil((width - x) / dx)), height: Math.max(0, Math.ceil((height - y) / dy)) })).filter(pass => pass.width && pass.height);
  const length = passes.reduce((size, pass) => size + (Math.ceil(pass.width * channels * depth / 8) + 1) * pass.height, 0);
  const bpp = Math.max(1, Math.ceil(channels * depth / 8));
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: length });

  if (raw.length !== length) {
    throw new Error('Invalid PNG pixels');
  }

  const rgba = new Uint8Array(width * height * 4);
  let scanOffset = 0;

  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);

    return x <= y && x <= z ? a : y <= z ? b : c;
  };

  for (const pass of passes) {
    const stride = Math.ceil(pass.width * channels * depth / 8), pixels = new Uint8Array(stride * pass.height);

    for (let y = 0; y < pass.height; y++) {
      const filter = raw[scanOffset + y * (stride + 1)];

      if (filter > 4) {
        throw new Error('Invalid PNG filter');
      }

      for (let x = 0; x < stride; x++) {
        const at = y * stride + x, a = x >= bpp ? pixels[at - bpp] : 0, b = y ? pixels[at - stride] : 0, c = y && x >= bpp ? pixels[at - stride - bpp] : 0;

        pixels[at] = raw[scanOffset + y * (stride + 1) + x + 1] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c));
      }

      for (let x = 0; x < pass.width; x++) {
        const at = y * stride + x * channels;
        const index = pixels[y * stride + Math.floor(x * depth / 8)] >> (8 - depth - x * depth % 8) & (1 << depth) - 1;
        const out = ((pass.y + y * pass.dy) * width + pass.x + x * pass.dx) * 4;

        if (type === 3) {
          if (!palette || index * 3 + 2 >= palette.length) {
            throw new Error('Invalid PNG palette');
          }

          rgba.set(palette.subarray(index * 3, index * 3 + 3), out);
          rgba[out + 3] = transparency?.[index] ?? 255;
        } else if (type === 0 || type === 4) {
          const gray = type === 0 ? Math.round(index * 255 / ((1 << depth) - 1)) : pixels[at];

          rgba.set([gray, gray, gray, type === 4 ? pixels[at + 1] : transparency && index === transparency.readUInt16BE(0) ? 0 : 255], out);
        } else {
          const transparent = transparency && [0, 1, 2].every(i => pixels[at + i] === transparency.readUInt16BE(i * 2));

          rgba.set([pixels[at], pixels[at + 1], pixels[at + 2], type === 6 ? pixels[at + 3] : transparent ? 0 : 255], out);
        }
      }
    }

    scanOffset += (stride + 1) * pass.height;
  }

  return { width, height, rgba };
}

export function pngAlpha(bytes: Buffer): ImageAlpha {
  const { width, height, rgba } = pngPixels(bytes);

  return { width, height, alpha: Uint8Array.from({ length: width * height }, (_, i) => rgba[i * 4 + 3]) };
}

/** Decode vanilla true-color/grayscale TGA images, including RLE and both origin axes. */
export function tgaPixels(bytes: Buffer): ImagePixels {
  const kind = bytes[2], width = bytes.readUInt16LE(12), height = bytes.readUInt16LE(14), depth = bytes[16], descriptor = bytes[17];
  const gray = kind === 3 || kind === 11, rle = kind === 10 || kind === 11, channels = depth / 8;

  if (bytes[1] || ![2, 3, 10, 11].includes(kind) || !(gray ? depth === 8 : depth === 24 || depth === 32) || !width || !height || width * height > 16777216) {
    throw new Error('Unsupported TGA layout');
  }

  const rgba = new Uint8Array(width * height * 4);
  let offset = 18 + bytes[0], index = 0;

  const put = (pixel: Uint8Array): void => {
    const x = index % width, y = Math.floor(index / width);
    const out = ((descriptor & 32 ? y : height - y - 1) * width + (descriptor & 16 ? width - x - 1 : x)) * 4;

    rgba.set(gray ? [pixel[0], pixel[0], pixel[0], 255] : [pixel[2], pixel[1], pixel[0], channels === 4 ? pixel[3] : 255], out);
    index++;
  };

  while (index < width * height) {
    const packet = rle ? bytes[offset++] : 0, count = rle ? (packet & 127) + 1 : 1;

    if (index + count > width * height) {
      throw new Error('Invalid TGA packet');
    }

    for (let i = 0; i < count; i++) {
      if (offset + channels > bytes.length) {
        throw new Error('Truncated TGA pixels');
      }

      put(bytes.subarray(offset, offset + channels));

      if (!rle || !(packet & 128) || i === count - 1) {
        offset += channels;
      }
    }
  }

  return { width, height, rgba };
}

export function alphaMethod(image: ImageAlpha, rectangle = [0, 0, image.width, image.height]): RenderMaterial {
  const [x, y, width, height] = rectangle;

  if (rectangle.length !== 4 || !rectangle.every(Number.isInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width || y + height > image.height) {
    throw new Error('Texture rectangle outside PNG');
  }

  let holes = false;

  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const a = image.alpha[row * image.width + col];

      if (a === undefined) {
        throw new Error('Texture rectangle outside PNG');
      }

      if (a > 0 && a < 255) {
        return 'blend';
      }

      holes ||= a === 0;
    }
  }

  return holes ? 'cutout' : 'opaque';
}

export async function nativeTextureAlpha(directory: string): Promise<Map<string, { method: RenderMaterial; width: number; height: number }>> {
  const entries = new Map<string, Buffer>();
  const packs = (await readdir(directory)).filter(name => /^vanilla(?:_\d+(?:\.\d+)*)?$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const pack of packs) {
    for (const group of ['textures', 'textures/blocks']) {
      const bytes = await readFile(join(directory, pack, '__brarchive', `${group}.brarchive`)).catch((error) => {
        if (error.code === 'ENOENT') {
          return undefined;
        }

        throw error;
      });

      if (!bytes) {
        continue;
      }

      if (bytes.subarray(0, 8).toString('hex') !== '7d2725b1a0527026') {
        throw new Error('Unsupported native texture archive');
      }

      const count = bytes.readUInt32LE(8), base = 16 + count * 256;

      if (base > bytes.length) {
        throw new Error('Invalid native texture archive');
      }

      for (let i = 0; i < count; i++) {
        const start = 16 + i * 256, name = bytes.toString('utf8', start + 1, start + 1 + bytes[start]);
        const offset = base + bytes.readUInt32LE(start + 248), size = bytes.readUInt32LE(start + 252);

        if (offset + size > bytes.length) {
          throw new Error('Invalid native texture member');
        }

        if (/\.png$/i.test(name)) {
          entries.set(`${group}/${name.replace(/\.png$/i, '')}`, Buffer.from(bytes.subarray(offset, offset + size)));
        }
      }
    }

    const loose = join(directory, pack, 'textures/blocks');

    for (const name of await readdir(loose).catch((error) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    })) {
      if (name.endsWith('.png')) {
        entries.set(`textures/blocks/${name.slice(0, -4)}`, await readFile(join(loose, name)));
      }
    }
  }

  const result = new Map<string, { method: RenderMaterial; width: number; height: number }>();

  for (const [path, bytes] of entries) {
    try {
      const image = pngAlpha(bytes);

      result.set(path, { method: alphaMethod(image), width: image.width, height: image.height });
    } catch { /* Unknown alpha formats use the verified Java atlas instead. */ }
  }

  return result;
}
