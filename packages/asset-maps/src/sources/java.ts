import type { ImagePixels } from './formats.ts';
import type { JavaArtifact, JavaAtlas, JavaManifest, JavaResources, JavaSource, Runtime } from './types.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { zipFiles, pngPixels } from './formats.ts';
import { lockedInput } from './download.ts';

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function canonical<T>(value: T): T;

function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
}

export const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(canonical(value)) + '\n');

/** Native classifiers and OS-specific artifacts are unnecessary for headless registry extraction. */
export function manifestArtifacts(manifest: JavaManifest): Omit<JavaArtifact, 'sha256'>[] {
  return [{ name: 'client', ...manifest.downloads.client }, ...manifest.libraries.filter(library => library.name.split(':').length === 3 && !library.rules?.some(rule => rule.os)).map((library) => {
    const { url, sha1, size } = library.downloads.artifact;

    return { name: library.name, url, sha1, size };
  })];
}

export function validateJavaManifest(source: JavaSource, bytes: Buffer): JavaManifest {
  if (createHash('sha1').update(bytes).digest('hex') !== source.manifest.sha1) {
    throw new Error('Java version manifest hash mismatch');
  }

  const manifest: JavaManifest = JSON.parse(bytes.toString('utf8'));

  if (manifest.id !== source.version || manifest.javaVersion?.majorVersion !== source.majorVersion) {
    throw new Error('Java manifest differs from the selected client');
  }

  const pinned = new Map([source.client, ...source.libraries].map(artifact => [artifact.name, artifact]));
  const artifacts = manifestArtifacts(manifest);

  if (pinned.size !== artifacts.length || source.libraries.length + 1 !== artifacts.length || artifacts.some((artifact) => {
    const pin = pinned.get(artifact.name);

    return !pin || (['url', 'sha1', 'size'] as const).some(key => pin[key] !== artifact[key]);
  })) { throw new Error('Java client and libraries differ from the official manifest'); }

  return manifest;
}

/** Encode an RGBA atlas with stable chunk order and compression. */
export function encodePng({ width, height, rgba }: ImagePixels): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error('Invalid atlas dimensions');
  }

  const crc = (bytes: Uint8Array): number => {
    let value = 0xffffffff;

    for (const byte of bytes) {
      value ^= byte;

      for (let bit = 0; bit < 8; bit++) {
        value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
      }
    }

    return (value ^ 0xffffffff) >>> 0;
  };

  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);

    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));

    return Buffer.concat([size, type, data, checksum]);
  };

  const header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1));

  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  for (let y = 0; y < height; y++) {
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Resolve the block atlas's declared sprite sources from the official resource files. */
export function javaResources(bytes: Buffer): JavaResources {
  const entries = zipFiles(bytes), models: JavaResources['models'] = {}, blockstates: JavaResources['blockstates'] = {}, sprites: JavaResources['sprites'] = new Map();

  for (const [name, read] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (name.startsWith('assets/minecraft/models/block/') && name.endsWith('.json')) {
      models[name.slice('assets/minecraft/models/block/'.length, -5)] = JSON.parse(read().toString('utf8'));
    }

    if (name.startsWith('assets/minecraft/blockstates/') && name.endsWith('.json')) {
      blockstates[name.slice('assets/minecraft/blockstates/'.length, -5)] = JSON.parse(read().toString('utf8'));
    }
  }

  const atlas = entries.get('assets/minecraft/atlases/blocks.json');

  if (!atlas) {
    throw new Error('The pinned Java client has no block atlas definition');
  }

  const add = (id: string, resource: string): void => {
    const name = resource.replace(/^minecraft:/, '');

    if (name.includes(':') || name.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('Unsupported Java sprite resource: ' + resource);
    }

    const read = entries.get('assets/minecraft/textures/' + name + '.png');

    if (!read) {
      throw new Error('Java atlas sprite is missing: ' + resource);
    }

    sprites.set(id.replace(/^minecraft:/, ''), pngPixels(read()));
  };

  const definition: { sources: { type: string; sprite?: string; resource: string; source: string; prefix: string }[] } = JSON.parse(atlas().toString('utf8'));

  for (const source of definition.sources) {
    if (source.type === 'minecraft:single') {
      add(source.sprite ?? source.resource, source.resource);
    } else if (source.type === 'minecraft:directory') {
      const directory = 'assets/minecraft/textures/' + source.source + '/';

      for (const name of entries.keys()) {
        if (name.startsWith(directory) && name.endsWith('.png')) {
          add(source.prefix + name.slice(directory.length, -4), name.slice('assets/minecraft/textures/'.length, -4));
        }
      }
    } else { throw new Error('Unsupported Java block atlas source: ' + source.type); }
  }

  return { models, blockstates, sprites, image: (resource): ImagePixels | undefined => {
    const name = resource.replace(/^minecraft:/, '').replace(/^textures\//, '').replace(/\.png$/, '');
    const read = entries.get('assets/minecraft/textures/' + name + '.png');

    return read ? pngPixels(read()) : undefined;
  } };
}

/** Pack full sprite sheets; animation-frame selection remains a conversion decision. */
export function javaAtlas(sprites: Map<string, ImagePixels>): JavaAtlas {
  const ordered = [...sprites].sort(([a, left], [b, right]) => right.height - left.height || right.width - left.width || (a < b ? -1 : a > b ? 1 : 0));
  const area = ordered.reduce((sum, [, image]) => sum + image.width * image.height, 0);
  const width = 2 ** Math.ceil(Math.log2(Math.max(1, Math.sqrt(area), ...ordered.map(([, image]) => image.width))));
  let x = 0, y = 0, row = 0;
  const rectangles: Record<string, [number, number, number, number]> = {};

  for (const [name, image] of ordered) {
    if (x + image.width > width) {
      y += row;
      x = 0;
      row = 0;
    }

    rectangles[name] = [x, y, image.width, image.height];
    x += image.width;
    row = Math.max(row, image.height);
  }

  const height = 2 ** Math.ceil(Math.log2(Math.max(1, y + row)));

  if (width * height > 64 * 1024 * 1024) {
    throw new Error('Java atlas exceeds the maintenance pixel limit');
  }

  const rgba = Buffer.alloc(width * height * 4);

  for (const [name, image] of ordered) {
    const [x, y] = rectangles[name];

    for (let row = 0; row < image.height; row++) {
      rgba.set(image.rgba.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * width + x) * 4);
    }
  }

  return { image: { width, height, rgba }, rectangles: canonical(rectangles), png: encodePng({ width, height, rgba }) };
}

function execute(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';

    const retain = (bytes: Buffer): void => {
      output = (output + bytes).slice(-32768);
    };

    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const timeout = setTimeout(() => child.kill(), 120000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve(output);
      } else { reject(new Error(`Java extraction exited ${code}: ${output}`)); }
    });
  });
}

/** Invoke only our extractor against hash-verified Mojang artifacts; no game client is launched. */
export async function javaRuntime(source: JavaSource, cache: string, { offline = false, force = false } = {}): Promise<Runtime> {
  const artifacts = [source.client, ...source.libraries];
  const files = await Promise.all(artifacts.map(async (artifact) => {
    const bytes = await lockedInput(artifact, cache, { offline, extension: '.jar', maxBytes: 128 * 1024 * 1024 });

    if (bytes.length !== artifact.size || createHash('sha1').update(bytes).digest('hex') !== artifact.sha1) {
      throw new Error('Mojang Java artifact differs from its manifest: ' + artifact.url);
    }

    return resolve(cache, artifact.sha256 + '.jar');
  }));
  const extractor = fileURLToPath(new URL('./AssetExtract.java', import.meta.url));
  const revision = hash(jsonBytes({ version: source.version, manifest: source.manifest.sha256, artifacts: artifacts.map(artifact => [artifact.name, artifact.sha256]).sort(([a], [b]) => a.localeCompare(b)),
    extractor: hash((await readFile(extractor, 'utf8')).replaceAll('\r\n', '\n')) }));
  const file = join(cache, revision + '.runtime.json');

  if (!force) {
    const cached = await readFile(file).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    const checksum = await readFile(file + '.sha256', 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });

    if (cached && checksum) {
      if (hash(cached) !== checksum.trim()) {
        throw new Error('Cached Java extraction hash does not match');
      }

      const value: Runtime = JSON.parse(cached.toString('utf8'));

      if (value.javaVersion === source.version && value.extractionRevision === revision) {
        return value;
      }

      throw new Error('Cached Java extraction provenance does not match');
    }
  }

  await mkdir(cache, { recursive: true });
  const executable = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const temporary = file + '.tmp';

  await execute(executable, ['-Xmx768m', '-Djava.awt.headless=true', '-cp', files.join(delimiter), extractor, source.version, resolve(temporary)], cache);
  const value: Runtime = JSON.parse(await readFile(temporary, 'utf8'));

  if (value.javaVersion !== source.version || !Object.keys(value.blocks ?? {}).length || !Object.keys(value.models ?? {}).length) {
    throw new Error('Java extractor returned incomplete registries');
  }

  value.extractionRevision = revision;
  const encoded = jsonBytes(value);

  await writeFile(temporary, encoded);
  await rename(temporary, file);
  await writeFile(file + '.sha256', hash(encoded) + '\n');

  return JSON.parse(encoded.toString('utf8'));
}
