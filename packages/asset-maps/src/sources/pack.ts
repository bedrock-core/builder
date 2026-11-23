import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { cache } from '../paths.ts';
import { readAssetRelease } from '../releases.ts';
import { lockedInput } from './download.ts';
import { zipFiles } from './formats.ts';
import type { Document, Resources } from '../bedrock/types.ts';

/** Read selected native documents directly from the pinned archive; never retain a second snapshot. */
export function bedrockResources(archive: Buffer): Resources {
  const files: Resources = new Map();
  let total = 0;

  for (const [path, member] of zipFiles(archive)) {
    const name = path.startsWith('resource_pack/')
      ? path.slice('resource_pack/'.length)
      : /^behavior_pack\/(?:blocks|items)\//.test(path)
        ? path.slice('behavior_pack/'.length)
        : /^metadata\/vanilladata_modules\/mojang-(?:blocks|items)\.json$/.test(path) ? path.replace('metadata/vanilladata_modules/', 'metadata/') : undefined;

    if (!name || !selectedPackAsset(name)) {
      continue;
    }

    if (name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || files.has(name)) {
      throw new Error('Invalid or duplicate native JSON member: ' + name);
    }

    const content = member();

    total += content.length;

    if (total > 128 * 1024 * 1024 || files.size >= 20000) {
      throw new Error('Native JSON inventory exceeds its size limit');
    }

    files.set(name, parsePackJson(content.toString('utf8')));
  }

  if (!files.has('metadata/mojang-blocks.json') || !files.has('metadata/mojang-items.json')) {
    throw new Error('The Bedrock source is missing native identifier metadata');
  }

  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

export async function nativeResources({ version, offline = false }: { version?: string; offline?: boolean } = {}): Promise<Resources> {
  const { source: { bedrock } } = await readAssetRelease(version);

  return bedrockResources(await lockedInput(bedrock.archive, cache, { offline, extension: '.zip', maxBytes: 256 * 1024 * 1024 }));
}

const excluded = new Set(['node_modules', '.git', 'build', 'dist', '.bedrock-core', 'physics_render', 'ui', 'sounds', 'particles', 'font', 'texts', 'structures', 'loot_tables', 'trading', 'recipes', 'functions']);
const archiveMagic = '7d2725b1a0527026';
const decoder = new TextDecoder('utf-8', { fatal: true });

export function selectedPackAsset(name: string): boolean {
  return /^(?:blocks|items|models|entity|entities|render_controllers|animation_controllers|animations)\/.+\.json$/i.test(name)
    || /^(?:blocks\.json|textures\/(?:terrain_texture|item_texture|flipbook_textures)\.json|metadata\/mojang-(?:items|blocks)\.json)$/i.test(name);
}

function memberName(name: string): string {
  const normalized = name.replaceAll('\\', '/');

  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
    || normalized.split('/').some(part => part === '..' || part === '.' || part.length === 0)) {
    throw new Error('invalid vanilla archive member name');
  }

  return normalized;
}

/** Parse pack JSON comments/trailing commas without interpreting any pack code. */
export function parsePackJson(text: string): Document {
  const errors: ParseError[] = [];
  const value = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });

  if (errors.length) {
    throw new SyntaxError(`invalid pack JSON: ${printParseErrorCode(errors[0].error)} at ${errors[0].offset}`);
  }

  return value;
}

/** Read authored JSON and the pinned, uncompressed vanilla archive format. Symlinks are not followed. */
export async function readPackAssets(directory: string, onFile: (path: string) => void = () => {}): Promise<Resources> {
  const files: Resources = new Map();

  async function visit(folder: string): Promise<void> {
    onFile(folder);
    const entries = await readdir(folder, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(folder, entry.name);

      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) {
          await visit(file);
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const name = relative(directory, file).replaceAll('\\', '/');

      if (selectedPackAsset(name)) {
        onFile(file);
        files.set(name, parsePackJson(await readFile(file, 'utf8')));
      }

      if (!entry.name.endsWith('.brarchive')) {
        continue;
      }

      const archived = name.replace(/^__brarchive\//, '');

      if (!/^(?:models(?:\/[^/]+)*|textures|blocks|items|entity|entities|render_controllers|animation_controllers|animations)\.brarchive$/.test(archived)) {
        continue;
      }

      onFile(file);
      const bytes = await readFile(file);

      if (bytes.length < 16 || bytes.subarray(0, 8).toString('hex') !== archiveMagic) {
        throw new Error(`unsupported vanilla archive: ${file}`);
      }

      const count = bytes.readUInt32LE(8), base = 16 + count * 256;

      if (count > 100000 || base > bytes.length) {
        throw new Error('invalid vanilla archive index');
      }

      const prefix = archived.replace(/\.brarchive$/, '');

      for (let i = 0; i < count; i++) {
        const start = 16 + i * 256, length = bytes[start];

        if (length < 1 || length > 247) {
          throw new Error('invalid vanilla archive name length');
        }

        const name = memberName(decoder.decode(bytes.subarray(start + 1, start + 1 + length)));
        const offset = base + bytes.readUInt32LE(start + 248), size = bytes.readUInt32LE(start + 252);

        if (offset > bytes.length || size > bytes.length - offset) {
          throw new Error('invalid vanilla archive member bounds');
        }

        const destination = `${prefix}/${name}`;

        if (!selectedPackAsset(destination)) {
          continue;
        }

        const text = decoder.decode(bytes.subarray(offset, offset + size));

        if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
          continue;
        }

        files.set(destination, parsePackJson(text));
      }
    }
  }

  await visit(directory);

  return files;
}
