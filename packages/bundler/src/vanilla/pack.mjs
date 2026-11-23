import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';
const excluded = new Set(['node_modules', '.git', 'build', 'dist', '.bedrock-core', 'ui', 'sounds', 'particles', 'font', 'texts', 'structures', 'loot_tables', 'trading', 'recipes', 'functions']);
const archiveMagic = '7d2725b1a0527026';
const decoder = new TextDecoder('utf-8', { fatal: true });

export function selectedPackAsset(name) {
  return /^(?:blocks|items|models|entity|entities|render_controllers|animation_controllers|animations)\/.+\.json$/i.test(name)
    || /^(?:blocks\.json|textures\/(?:terrain_texture|item_texture|flipbook_textures)\.json|metadata\/mojang-(?:items|blocks)\.json)$/i.test(name);
}

function memberName(name) {
  const normalized = name.replaceAll('\\', '/');

  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
    || normalized.split('/').some(part => part === '..' || part === '.' || part.length === 0)) {
    throw new Error('invalid vanilla archive member name');
  }

  return normalized;
}

/** Parse pack JSON comments/trailing commas without interpreting any pack code. */
export function parsePackJson(text) {
  const errors = [];
  const value = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });

  if (errors.length) {
    throw new SyntaxError(`invalid pack JSON: ${printParseErrorCode(errors[0].error)} at ${errors[0].offset}`);
  }

  return value;
}

/** Read authored JSON and the pinned, uncompressed vanilla archive format. Symlinks are not followed. */
export async function readPackAssets(directory, onFile = () => { }) {
  const files = new Map();

  async function visit(folder) {
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

/** Read a samples checkout or the ordered vanilla layers of a local pack stack. */
export async function readNativePacks(directory, target, onFile = () => { }) {
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
  const resources = new Map();

  const merge = (found) => {
    for (const [name, document] of found) {
      const previous = resources.get(name);

      if (name === 'blocks.json') {
        resources.set(name, { ...previous, ...document });
      } else if (/^textures\/(?:terrain|item)_texture\.json$/.test(name)) {
        resources.set(name, { ...previous, ...document, texture_data: { ...previous?.texture_data, ...document.texture_data } });
      } else {
        resources.set(name, document);
      }
    }
  };

  onFile(directory);

  if (folders.has('resource_pack') || folders.has('behavior_pack')) {
    for (const name of ['resource_pack', 'behavior_pack']) {
      if (folders.has(name)) {
        merge(await readPackAssets(join(directory, name), onFile));
      }
    }

    for (const name of ['mojang-blocks.json', 'mojang-items.json']) {
      const file = join(directory, 'metadata/vanilladata_modules', name);
      const text = await readFile(file, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') {
          return undefined;
        }

        throw error;
      });

      if (text !== undefined) {
        onFile(file);
        resources.set('metadata/' + name, parsePackJson(text));
      }
    }

    return resources;
  }

  const parts = value => value.split('.').map(Number);

  const compare = (a, b) => {
    const left = parts(a), right = parts(b);

    for (let i = 0; i < 3; i++) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) {
        return (left[i] ?? 0) - (right[i] ?? 0);
      }
    }

    return 0;
  };

  const layers = [...folders].filter(name => name === 'vanilla' || (/^vanilla_\d+(?:\.\d+)*$/.test(name) && compare(name.slice(8), target) <= 0))
    .sort((a, b) => a === 'vanilla' ? -1 : b === 'vanilla' ? 1 : compare(a.slice(8), b.slice(8)));

  if (!layers.length) {
    return readPackAssets(directory, onFile);
  }

  for (const layer of layers) {
    merge(await readPackAssets(join(directory, layer), onFile));
  }

  return resources;
}
