import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { compileGeometry } from './geometry.ts';
import { resolveJavaModel } from './compiler.ts';
import { pngPixels, tgaPixels, zipFiles } from '../sources/formats.ts';
import type { ImagePixels } from '../sources/formats.ts';
import type { CompileInput } from './compiler.ts';
import type { CompiledModelSource, ModelSources, PackedFace, RenderMaterial } from './types.ts';

type Rect = [number, number, number, number];
type UVTransform = [number, number, number, number, number, number];
type Json = Record<string, unknown>;
export interface TextureSourceLock { schemaVersion: 1; minecraft: string; archive: { url: string; sha256: string }; license?: { file: string; url: string; sha256: string } }

export interface NativeImage extends ImagePixels { frame: Rect; method: RenderMaterial }

export interface FaceTexture {
  source: string;
  path?: string;
  method?: RenderMaterial;
  transform?: UVTransform;
  sourceBounds?: Rect;
  resolution?: 'mapping' | 'identity' | 'naming' | 'pixels' | 'pixel-region' | 'layout';
  error?: string;
}

export interface TextureBindings {
  schemaVersion: 1; source: ModelSources; native: TextureSourceLock;
  paths: string[]; models: Record<string, FaceTexture[]>;
  images: Record<string, { width: number; height: number; frame: Rect; method: RenderMaterial }>;
  statistics: { faces: number; resolved: number; unresolved: number; methods: Record<string, number> };
}

/** Apply a verified texture transform after block UV locking, retaining the quad's geometry and winding. */
export function remapFaceTexture(face: PackedFace, binding: FaceTexture): PackedFace {
  const [u, v, width, height] = face.slice(9, 13);
  const bounds = binding.sourceBounds;

  if (bounds && (Math.min(u, u + width) < bounds[0] - 1e-6 || Math.max(u, u + width) > bounds[0] + bounds[2] + 1e-6 || Math.min(v, v + height) < bounds[1] - 1e-6 || Math.max(v, v + height) > bounds[1] + bounds[3] + 1e-6)) {
    throw new Error('UV locking samples outside the verified native texture region');
  }

  const [x, y, a, b, c, d] = binding.transform ?? [0, 0, 1, 0, 0, 1];
  const project = (u: number, v: number): number[] => [x + a * u + b * v, y + c * u + d * v];
  const p = project(u, v), q = project(u + width, v), r = project(u, v + height);

  if ([...p, ...q, ...r].some(value => !Number.isFinite(value))) {
    throw new Error('Invalid native texture transform');
  }

  if (Math.abs(q[1] - p[1]) < 1e-6 && Math.abs(r[0] - p[0]) < 1e-6) {
    return [...face.slice(0, 9), p[0], p[1], q[0] - p[0], r[1] - p[1], ...face.slice(13)];
  }

  if (Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(r[1] - p[1]) > 1e-6) {
    throw new Error('Native texture transform is not orthogonal');
  }

  return [face[0] + face[6], face[1] + face[7], face[2] + face[8], -face[6], -face[7], -face[8], ...face.slice(3, 6), r[0], r[1], p[0] - r[0], q[1] - p[1], ...face.slice(13)];
}

const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];
const clean = (path: string): string => path.replace(/^minecraft:/, '').replace(/\.(?:png|tga)$/i, '');
const tokens = (path: string): string[] => clean(path).replace(/^(?:textures\/)?(?:blocks?|items?|entity)\//, '').split(/[_/]+/).map(value => value.replace(/s$/, ''));

export const textureNameKey = (path: string): string => tokens(path).join('').split('').sort().join('');
const tokenKey = textureNameKey;

/** Mapping arrays are ordered alternatives; nested filenames remain relative to their texture group. */
export function textureCandidates(source: string, mappings: Json): { path: string; resolution: 'mapping' | 'identity' }[] {
  source = clean(source);
  const slash = source.indexOf('/'), group = source.slice(0, slash), folder = ({ block: 'blocks', item: 'items' } as Record<string, string>)[group] ?? group;
  let current: unknown = mappings, rest = source;

  while (record(current)) {
    if (Object.hasOwn(current, rest)) {
      current = current[rest];
      break;
    }

    const at = rest.indexOf('/');

    if (at < 0) {
      current = undefined;
      break;
    }

    current = current[rest.slice(0, at)];
    rest = rest.slice(at + 1);
  }

  const path = (name: string): string => {
    name = clean(name);

    return name.startsWith('textures/') ? name : /^blocks\/|^items\/|^entity\//.test(name) ? `textures/${name}` : `textures/${folder}/${name}`;
  };

  const result: { path: string; resolution: 'mapping' | 'identity' }[] = strings(current).map(value => ({ path: path(value), resolution: 'mapping' }));

  result.push({ path: `textures/${folder}/${source.slice(slash + 1)}`, resolution: 'identity' });

  return result.filter((value, i) => !value.path.split('/').some(part => !part || part === '.' || part === '..') && result.findIndex(other => other.path === value.path) === i);
}

/** Learn repeated filename substitutions from the published map, requiring two independent witnesses. */
export function inferredTextureCandidates(mappings: Json, nativePaths: Iterable<string>): (source: string) => string[] {
  const words = (path: string): string[] => posix.basename(clean(path)).split('_');
  const evidence = new Map<string, { from: string[]; to: string[]; sources: Set<string> }>();

  const visit = (object: Json, prefix = ''): void => {
    for (const [key, value] of Object.entries(object)) {
      const source = prefix ? prefix + '/' + key : key;

      if (record(value)) {
        visit(value, source);
        continue;
      }

      for (const target of strings(value)) {
        const from = words(source), to = words(target);

        for (let i = from.length - 1; i >= 0; i--) {
          const at = to.indexOf(from[i]);

          if (at >= 0) {
            from.splice(i, 1);
            to.splice(at, 1);
          }
        }

        if (!from.length || !to.length || from.length > 2 || to.length > 2) {
          continue;
        }

        const key = JSON.stringify([from, to]);

        if (!evidence.has(key)) {
          evidence.set(key, { from, to, sources: new Set() });
        }

        evidence.get(key)!.sources.add(source);
      }
    }
  };

  visit(mappings);
  const substitutions = [...evidence.values()].filter(value => value.sources.size >= 2);
  const key = (words: string[]): string => [...words].sort().join('|');
  const paths = new Map<string, string[]>();

  for (const path of nativePaths) {
    const name = key(words(path));

    paths.set(name, [...paths.get(name) ?? [], path]);
  }

  return source => [...new Set(substitutions.flatMap(({ from, to }) => {
    const remaining = words(source);

    for (const word of from) {
      const at = remaining.indexOf(word);

      if (at < 0) {
        return [];
      }

      remaining.splice(at, 1);
    }

    return paths.get(key([...remaining, ...to])) ?? [];
  }))];
}

/** Decode only albedo images; PBR channel references are excluded using the texture-set documents. */
export function nativeTextureImages(archive: Buffer, flipbooks: readonly Json[], unavailable: { path: string; reason: string }[] = []): Map<string, NativeImage> {
  const entries = zipFiles(archive), colors = new Set<string>(), channels = new Set<string>();

  for (const [name, read] of entries) {
    if (!/^resource_pack\/textures\/.+\.texture_set\.json$/.test(name)) {
      continue;
    }

    const set = JSON.parse(read().toString('utf8'))['minecraft:texture_set'];

    if (!record(set)) {
      continue;
    }

    for (const [role, reference] of Object.entries(set)) {
      if (typeof reference !== 'string') {
        continue;
      }

      const path = reference.startsWith('textures/') ? reference : posix.join(posix.dirname(name.slice('resource_pack/'.length)), reference);

      (role === 'color' ? colors : channels).add(clean(path));
    }
  }

  const animations = new Map<string, Json>();

  for (const value of flipbooks) {
    if (typeof value.flipbook_texture === 'string') {
      animations.set(value.flipbook_texture, value);
    }
  }

  const images = new Map<string, NativeImage>();
  let decoded = 0;

  for (const [name, read] of entries) {
    if (!/^resource_pack\/textures\/(?:blocks|entity|items)\/.+\.(?:png|tga)$/.test(name)) {
      continue;
    }

    const path = clean(name.slice('resource_pack/'.length));

    if ((channels.has(path) && !colors.has(path)) || (images.has(path) && name.endsWith('.tga'))) {
      continue;
    }

    let image: ImagePixels;

    try {
      image = name.endsWith('.png') ? pngPixels(read()) : tgaPixels(read());
    } catch (error) {
      unavailable.push({ path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    decoded += image.rgba.length;

    if (decoded > 256 * 1024 * 1024) {
      throw new Error('Native albedo images exceed 256 MiB decoded');
    }

    const animation = animations.get(path), first = Array.isArray(animation?.frames) ? animation.frames[0] : 0;
    const index = typeof first === 'number' ? first : record(first) && typeof first.index === 'number' ? first.index : 0;
    const height = animation ? image.width : image.height;

    if (image.height % height || index < 0 || !Number.isInteger(index) || (index + 1) * height > image.height) {
      throw new Error(`Invalid native flipbook frame: ${path}`);
    }

    const frame: Rect = [0, index * height, image.width, height];
    let method: RenderMaterial = 'opaque';

    for (let y = frame[1]; y < frame[1] + frame[3]; y++) {
      for (let x = 0; x < image.width; x++) {
        const alpha = image.rgba[(y * image.width + x) * 4 + 3];

        if (alpha > 0 && alpha < 255) {
          method = 'blend';
          break;
        }

        if (!alpha) {
          method = 'cutout';
        }
      }

      if (method === 'blend') {
        break;
      }
    }

    images.set(path, { ...image, frame, method });
  }

  return images;
}

const pixelEqual = (a: Uint8Array, at: number, b: Uint8Array, bt: number): boolean => a[at + 3] === b[bt + 3] && (!a[at + 3] || (a[at] === b[bt] && a[at + 1] === b[bt + 1] && a[at + 2] === b[bt + 2]));

/** Compare visible pixels; RGB channels below fully transparent pixels do not affect appearance. */
export function pixelHash(image: ImagePixels, rectangle: Rect): string {
  const [x, y, width, height] = rectangle;

  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width || y + height > image.height) {
    throw new Error('Pixel rectangle is outside its image');
  }

  const hash = createHash('sha256').update(`${width},${height}:`), row = new Uint8Array(width * 4);

  for (let v = y; v < y + height; v++) {
    row.set(image.rgba.subarray((v * image.width + x) * 4, (v * image.width + x + width) * 4));

    for (let i = 0; i < row.length; i += 4) {
      if (!row[i + 3]) {
        row[i] = row[i + 1] = row[i + 2] = 0;
      }
    }

    hash.update(row);
  }

  return hash.digest('hex');
}

function oriented(x: number, y: number, width: number, height: number, orientation: number, pixel = false): [number, number] {
  const edge = pixel ? 1 : 0, turn = orientation % 4;
  const point: [number, number] = turn === 0 ? [x, y] : turn === 1 ? [height - edge - y, x] : turn === 2 ? [width - edge - x, height - edge - y] : [y, width - edge - x];

  if (orientation >= 4) {
    point[0] = (turn % 2 ? height : width) - edge - point[0];
  }

  return point;
}

function findRegion(source: ImagePixels, rect: Rect, target: NativeImage): [number, number, number] | undefined {
  const [sx, sy, width, height] = rect, [fx, fy, fw, fh] = target.frame;

  for (let orientation = 0; orientation < 8; orientation++) {
    const w = orientation % 2 ? height : width, h = orientation % 2 ? width : height;

    for (let y = fy; y <= fy + fh - h; y++) {
      for (let x = fx; x <= fx + fw - w; x++) {
        let match = true;

        for (let v = 0; match && v < height; v++) {
          for (let u = 0; u < width; u++) {
            const [tx, ty] = oriented(u, v, width, height, orientation, true);

            if (!pixelEqual(source.rgba, ((sy + v) * source.width + sx + u) * 4, target.rgba, ((y + ty) * target.width + x + tx) * 4)) {
              match = false;
              break;
            }
          }
        }

        if (match) {
          return [x, y, orientation];
        }
      }
    }
  }

  return undefined;
}

export function createTextureResolver(input: {
  mappings: Json; images: Map<string, NativeImage>; atlas: ImagePixels; rectangles: Record<string, number[]>;
}): (source: string, uv: Rect, context?: string) => FaceTexture {
  const hashes = new Map<string, string[]>(), semantic = new Map<string, string[]>(), cache = new Map<string, FaceTexture>();
  const basenames = new Map<string, string[]>();

  for (const [path, image] of input.images) {
    const hash = pixelHash(image, image.frame), key = tokenKey(path);

    hashes.set(hash, [...hashes.get(hash) ?? [], path]);
    semantic.set(key, [...semantic.get(key) ?? [], path]);
    const basename = posix.basename(path);

    basenames.set(basename, [...basenames.get(basename) ?? [], path]);
  }

  const addMappedNames = (object: Json, prefix = ''): void => {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}/${key}` : key;

      if (record(value)) {
        addMappedNames(value, path);
      } else {
        const targets = textureCandidates(path, input.mappings).flatMap(value => [value.path, ...basenames.get(posix.basename(value.path)) ?? []]).filter(path => input.images.has(path));
        const name = tokenKey(path);

        semantic.set(name, [...new Set([...semantic.get(name) ?? [], ...targets])]);
      }
    }
  };

  addMappedNames(input.mappings);
  const inferred = inferredTextureCandidates(input.mappings, input.images.keys());

  return (source, uv, context = '') => {
    source = clean(source);
    const key = JSON.stringify([source, uv, context]);

    if (cache.has(key)) {
      return cache.get(key)!;
    }

    const save = (value: Omit<FaceTexture, 'source'>): FaceTexture => {
      const result = { source, ...value };

      cache.set(key, result);

      return result;
    };

    const rectangle = input.rectangles[source];

    if (!rectangle) {
      return save({ error: 'Java sprite rectangle is unavailable' });
    }

    const [ax, ay, width, height] = rectangle;
    const candidates: { path: string; resolution: 'mapping' | 'identity' | 'naming' }[] = textureCandidates(source, input.mappings).filter(value => input.images.has(value.path));
    const inferredPaths = inferred(source);

    if (inferredPaths.length === 1) {
      candidates.push({ path: inferredPaths[0], resolution: 'naming' });
    }

    for (const { path, resolution } of candidates) {
      const image = input.images.get(path)!;
      const sourceHeight = image.frame[3] < image.height && height % width === 0 ? width : height;

      if (width / sourceHeight === image.frame[2] / image.frame[3]) {
        return save({ path, method: image.method, transform: [0, 0, 1, 0, 0, 1], resolution });
      }
    }

    const matching = hashes.get(pixelHash(input.atlas, [ax, ay, width, height]));

    if (matching?.length === 1) {
      const path = matching[0];

      return save({ path, method: input.images.get(path)!.method, transform: [0, 0, 1, 0, 0, 1], resolution: 'pixels' });
    }

    const contextTokens = new Set([...tokens(source), ...tokens(context)]);
    const contextPaths = context ? [...input.images.keys()].filter(path => tokens(path).length >= 2 && tokens(path).every(token => contextTokens.has(token))) : [];
    const patchPaths = [...new Set([...candidates.map(value => value.path), ...semantic.get(tokenKey(source)) ?? [], ...contextPaths])].sort();
    const bounds: Rect = [Math.min(uv[0], uv[0] + uv[2]), Math.min(uv[1], uv[1] + uv[3]), Math.abs(uv[2]), Math.abs(uv[3])];
    const pixels = [bounds[0] * width, bounds[1] * height, bounds[2] * width, bounds[3] * height];

    if (pixels.every(value => Math.abs(Math.round(value) - value) < 1e-4) && pixels[2] > 0 && pixels[3] > 0 && pixels[0] >= 0 && pixels[1] >= 0 && pixels[0] + pixels[2] <= width && pixels[1] + pixels[3] <= height) {
      const rect: Rect = [Math.round(pixels[0]), Math.round(pixels[1]), Math.round(pixels[2]), Math.round(pixels[3])];
      const patches = patchPaths.flatMap((path) => {
        const image = input.images.get(path)!, region = findRegion(input.atlas, [ax + rect[0], ay + rect[1], rect[2], rect[3]], image);

        return region ? [{ path, image, region }] : [];
      });

      if (patches.length === 1) {
        const { path, image, region } = patches[0];

        const convert = (u: number, v: number): [number, number] => {
          const point = oriented(u * width - rect[0], v * height - rect[1], rect[2], rect[3], region[2]);

          return [(region[0] + point[0] - image.frame[0]) / image.frame[2], (region[1] + point[1] - image.frame[1]) / image.frame[3]];
        };

        const a = convert(0, 0), b = convert(1, 0), c = convert(0, 1);

        return save({ path, method: image.method, transform: [a[0], a[1], b[0] - a[0], c[0] - a[0], b[1] - a[1], c[1] - a[1]], sourceBounds: bounds, resolution: 'pixel-region' });
      }
    }

    return save({ error: matching?.length ? 'Native pixel match is ambiguous' : patchPaths.length ? 'Native texture layout has no exact pixel-region match' : 'No native filename or unique pixel match' });
  };
}

/** Recover texture symbols from the exact source models while preserving the checked geometry pools. */
export function buildTextureBindings(input: {
  compiled: CompiledModelSource; models: CompileInput['models']; mappings: Json; images: Map<string, NativeImage>;
  atlas: ImagePixels; rectangles: Record<string, number[]>; native: TextureSourceLock;
}): TextureBindings {
  if (input.native.minecraft !== input.compiled.source.bedrock) {
    throw new Error('Texture and model inputs must use the same Bedrock release');
  }

  const resolve = createTextureResolver(input), models: Record<string, FaceTexture[]> = {}, paths = new Set<string>();
  const statistics: TextureBindings['statistics'] = { faces: 0, resolved: 0, unresolved: 0, methods: {} };

  for (const binding of input.compiled.models) {
    const model = resolveJavaModel(binding.name, input.models), symbols: { path: string; translucent: boolean }[] = [];
    const geometry = compileGeometry(model, (symbol) => {
      let path: unknown = !symbol.includes('/') && Object.hasOwn(model.textures ?? {}, symbol) ? `#${symbol}` : symbol, translucent = false;
      const seen = new Set<string>();

      for (;;) {
        if (record(path)) {
          translucent ||= Boolean(path.force_translucent);
          path = path.sprite;
        }

        if (typeof path !== 'string' || !path) {
          throw new Error(`Missing Java texture symbol: ${binding.name}/${symbol}`);
        }

        if (!path.startsWith('#')) {
          break;
        }

        if (seen.has(path)) {
          throw new Error(`Cyclic Java texture symbol: ${binding.name}/${symbol}`);
        }

        seen.add(path);
        path = model.textures?.[path.slice(1)];
      }

      symbols.push({ path: clean(path), translucent });

      return symbols.length - 1;
    });
    const checked = input.compiled.geometries[binding.geometry];

    if (geometry.faces.length !== checked.faces.length || geometry.faces.some((face, i) => face.slice(0, 13).some((value, j) => Math.abs(value - checked.faces[i][j]) > 1e-6))) {
      throw new Error(`Source texture geometry differs from checked geometry: ${binding.name}`);
    }

    models[binding.name] = geometry.faces.map((face) => {
      const symbol = symbols[face[13]], selected = resolve(symbol.path, [face[9], face[10], face[11], face[12]], binding.name);
      const value = symbol.translucent && selected.path ? { ...selected, method: 'blend' as const } : selected;

      statistics.faces++;

      if (value.path) {
        paths.add(value.path);
        statistics.resolved++;
        statistics.methods[value.resolution!] = (statistics.methods[value.resolution!] ?? 0) + 1;
      } else { statistics.unresolved++; }

      return value;
    });
  }

  // Shared templates retain their UV layout across material variants. Require two
  // independent pixel-verified sheets before applying that layout to another sheet.
  const families = new Map<string, Map<string, { sources: Set<string>; sample: FaceTexture }>>();
  const compiledModels = new Map(input.compiled.models.map(model => [model.name, model]));

  const family = (name: string, index: number, texture: FaceTexture, path: string): string | undefined => {
    const source = input.models[name.replace(/^minecraft:/, '').replace(/^block\//, '')];
    const rectangle = input.rectangles[texture.source], image = input.images.get(path);
    const binding = compiledModels.get(name);
    const face = binding && input.compiled.geometries[binding.geometry].faces[index];

    return source?.parent && rectangle && image && face ? JSON.stringify([source.parent, face.slice(0, 13), rectangle.slice(2), image.frame.slice(2)]) : undefined;
  };

  for (const [name, faces] of Object.entries(models)) {
    for (const [i, value] of faces.entries()) {
      if (value.resolution !== 'pixel-region' || !value.path) {
        continue;
      }

      const key = family(name, i, value, value.path);

      if (!key) {
        continue;
      }

      if (!families.has(key)) {
        families.set(key, new Map());
      }

      const layouts = families.get(key)!, signature = JSON.stringify([value.transform, value.sourceBounds]);

      if (!layouts.has(signature)) {
        layouts.set(signature, { sources: new Set(), sample: value });
      }

      layouts.get(signature)!.sources.add(value.source);
    }
  }

  for (const [name, faces] of Object.entries(models)) {
    for (const [i, value] of faces.entries()) {
      if (value.path) {
        continue;
      }

      const targets = textureCandidates(value.source, input.mappings).filter(candidate => input.images.has(candidate.path));

      if (targets.length !== 1) {
        continue;
      }

      const path = targets[0].path, key = family(name, i, value, path), layouts = key && families.get(key);

      if (!layouts) {
        continue;
      }

      const ranked = [...layouts.values()].sort((a, b) => b.sources.size - a.sources.size);
      const candidate = ranked[0];

      if (candidate.sources.size < 2 || ranked[1]?.sources.size === candidate.sources.size) {
        continue;
      }

      faces[i] = { source: value.source, path, method: input.images.get(path)!.method, transform: candidate.sample.transform, sourceBounds: candidate.sample.sourceBounds, resolution: 'layout' };
      paths.add(path);
      statistics.resolved++;
      statistics.unresolved--;
      statistics.methods.layout = (statistics.methods.layout ?? 0) + 1;
    }
  }

  const images = Object.fromEntries([...input.images].map(([path, { width, height, frame, method }]) => [path, { width, height, frame, method }]).sort(([a], [b]) => String(a).localeCompare(String(b))));

  return { schemaVersion: 1, source: input.compiled.source, native: input.native, paths: [...paths].sort(), models, images, statistics };
}
