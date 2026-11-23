import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import yauzl from 'yauzl';
import { parsePackJson, selectedPackAsset } from './pack.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function assetFile(root, name) {
  if (typeof name !== 'string' || name.includes('\\') || !/^(behavior_pack|resource_pack)\/.+\.json$/.test(name)) {
    throw new Error('Invalid asset-map member');
  }

  const target = resolve(root, name), local = relative(root, target);

  if (local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local) || name.split('/').some(part => part === '.' || part === '..' || !part)) {
    throw new Error('Asset-map member leaves the package');
  }

  return target;
}

/** Parse only selected JSON members from an official, hash-verified samples archive. */
export async function archiveResources(file) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const resources = new Map();
  let count = 0, total = 0;

  await new Promise((resolve, reject) => {
    const fail = (error) => {
      zip.close();
      reject(error);
    };

    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      void (async () => {
        const name = entry.fileName;
        const member = name.startsWith('resource_pack/')
          ? name.slice(14)
          : /^behavior_pack\/(?:blocks|items)\//.test(name)
            ? name.slice(14)
            : /^metadata\/vanilladata_modules\/mojang-(?:blocks|items)\.json$/.test(name) ? name.replace('metadata/vanilladata_modules/', 'metadata/') : undefined;

        if (!member || !selectedPackAsset(member)) {
          zip.readEntry();

          return;
        }

        if (member.includes('\\') || member.split('/').some(part => !part || part === '.' || part === '..') || entry.generalPurposeBitFlag & 1
          || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 || entry.uncompressedSize > 32 * 1024 * 1024 || ++count > 20000) {
          throw new Error('Invalid native asset archive member');
        }

        const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
        const chunks = [];
        let size = 0;

        for await (const chunk of stream) {
          size += chunk.length;
          total += chunk.length;

          if (size > entry.uncompressedSize || total > 128 * 1024 * 1024) {
            throw new Error('Native asset archive exceeds its size limit');
          }

          chunks.push(chunk);
        }

        if (size !== entry.uncompressedSize) {
          throw new Error('Native archive member length mismatch');
        }

        resources.set(member, parsePackJson(Buffer.concat(chunks).toString('utf8')));
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });

  if (!resources.size) {
    throw new Error('Native archive contains no asset definitions');
  }

  return resources;
}

export async function upstreamResources(lock, { dependencyRoot = process.cwd(), cacheRoot, nativeInputs, offline = false, registerDependency = () => { } } = {}) {
  if (nativeInputs) {
    const file = resolve(nativeInputs), bytes = await readFile(file), document = parsePackJson(bytes.toString('utf8'));

    if (document.minecraft !== lock.minecraft || document.schemaVersion !== 1 || !document.files || (lock.snapshot?.sha256 && hash(bytes) !== lock.snapshot.sha256)) {
      throw new Error('Native metadata snapshot does not match the source lock');
    }

    registerDependency(file);

    return new Map(Object.entries(document.files));
  }

  const upstream = lock.upstream;

  if (upstream?.repository !== 'https://github.com/Mojang/bedrock-samples' || !/^[a-f0-9]{64}$/.test(upstream.archive?.sha256)
    || !upstream.archive.url.startsWith(`https://github.com/Mojang/bedrock-samples/releases/download/${upstream.tag}/`)) {
    throw new Error('Invalid Mojang asset source lock');
  }

  const cache = resolve(cacheRoot ?? join(dependencyRoot, '.bedrock-core/cache/asset-sources'));
  const file = join(cache, upstream.archive.sha256 + '.zip');
  let bytes = await readFile(file).catch((error) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  });

  if (!bytes) {
    if (offline) {
      throw new Error('Pinned Mojang asset archive is not cached; fetch it or supply nativeInputs/nativePacks');
    }

    const response = await fetch(upstream.archive.url, { signal: AbortSignal.timeout(120000) });

    if (!response.ok) {
      throw new Error('Native asset download failed: HTTP ' + response.status);
    }

    const chunks = [];
    let length = 0;

    for await (const chunk of response.body) {
      length += chunk.length;

      if (length > 256 * 1024 * 1024) {
        throw new Error('Native asset archive exceeds 256 MiB');
      }

      chunks.push(chunk);
    }

    bytes = Buffer.concat(chunks);

    if (hash(bytes) !== upstream.archive.sha256) {
      throw new Error('Native asset archive hash mismatch');
    }

    await mkdir(cache, { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';

    await writeFile(temporary, bytes);
    await rename(temporary, file);
  }

  if (hash(bytes) !== upstream.archive.sha256) {
    throw new Error('Cached native asset archive hash mismatch');
  }

  registerDependency(file);

  return archiveResources(file);
}
