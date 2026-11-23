import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { pngAlpha, pngPixels, tgaPixels, alphaMethod, zipEntry } from '../src/sources/formats.ts';

function zipFixture(name: string, content: Buffer): Buffer {
  const path = Buffer.from(name), payload = deflateRawSync(content);
  const local = Buffer.alloc(30), directory = Buffer.alloc(46), end = Buffer.alloc(22);

  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(path.length, 26);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(payload.length, 20);
  directory.writeUInt32LE(content.length, 24);
  directory.writeUInt16LE(path.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + path.length, 12);
  end.writeUInt32LE(local.length + path.length + payload.length, 16);

  return Buffer.concat([local, path, payload, directory, path, end]);
}

function pngFixture(): Buffer {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(3);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;

  const chunk = (name: string, data: Buffer): Buffer => {
    const result = Buffer.alloc(data.length + 12);

    result.writeUInt32BE(data.length);
    result.write(name, 4);
    data.copy(result, 8);

    return result;
  };

  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 20, 30, 40, 255, 20, 30, 40, 0, 20, 30, 40, 128]))), chunk('IEND', Buffer.alloc(0))]);
}

test('reads only the requested ZIP member without extracting archive paths', () => {
  const zip = zipFixture('data/blocks_debug.json', Buffer.from('{"minecraft:stone":{}}'));

  assert.equal(zipEntry(zip, 'data/blocks_debug.json').toString(), '{"minecraft:stone":{}}');
  assert.throws(() => zipEntry(zip, '../absent'), /Missing ZIP entry/);
  assert.throws(() => zipEntry(Buffer.alloc(24), 'anything'), /Missing ZIP directory/);
});

test('classifies actual PNG alpha and rejects rectangles outside image boundaries', () => {
  const image = pngAlpha(pngFixture());

  assert.equal(alphaMethod(image, [0, 0, 1, 1]), 'opaque');
  assert.equal(alphaMethod(image, [0, 0, 2, 1]), 'cutout');
  assert.equal(alphaMethod(image), 'blend');
  assert.throws(() => alphaMethod(image, [image.width, 0, 1, 1]), /outside PNG/);
  assert.throws(() => alphaMethod(image, [-1, 0, 1, 1]), /outside PNG/);
});

test('decodes Adam7 passes into their final pixel positions', () => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(3);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = 1;

  const chunk = (name: string, data: Buffer): Buffer => {
    const bytes = Buffer.alloc(data.length + 12);

    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4);
    data.copy(bytes, 8);

    return bytes;
  };

  const pixel = (id: number): number[] => [id, id * 2, id * 3, 255];
  const scanlines = Buffer.from([0, ...pixel(1), 0, ...pixel(3), 0, ...pixel(2), 0, ...pixel(4), ...pixel(5), ...pixel(6)]);
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);

  assert.deepEqual([...pngPixels(bytes).rgba], [1, 2, 3, 4, 5, 6].flatMap(pixel));
});

test('decodes TGA RLE packets and right-origin scanlines without changing colors', () => {
  const header = Buffer.alloc(18);

  header[2] = 10;
  header.writeUInt16LE(2, 12);
  header.writeUInt16LE(1, 14);
  header[16] = 24;
  header[17] = 48;
  const bytes = Buffer.concat([header, Buffer.from([1, 60, 50, 40, 30, 20, 10])]);

  assert.deepEqual([...tgaPixels(bytes).rgba], [10, 20, 30, 255, 40, 50, 60, 255]);
  assert.throws(() => tgaPixels(bytes.subarray(0, bytes.length - 1)), /Truncated/);
});
