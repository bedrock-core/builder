import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, safe } from '../files.ts';
import { archiveCache, root, type TypeRelease } from '../releases.ts';
import { extractTgz } from './tar.ts';

export async function withSchemaSdk<T>(release: TypeRelease, use: (directory: string) => Promise<T>): Promise<T> {
  const file = path.join(archiveCache, release.schemaVersion + '.tgz');

  await safe(root, file);
  await mkdir(archiveCache, { recursive: true });
  const directory = await mkdtemp(path.join(archiveCache, 'sdk-'));

  try {
    const cached = await exists(file);
    const version = release.schemaVersion;
    const bytes = cached ? await readFile(file) : await downloadSdk(version);

    if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== release.schemaIntegrity) {
      throw new Error('Mojang schema SDK integrity mismatch for ' + version);
    }

    if (!cached) {
      const temporary = path.join(directory, 'download.tgz');

      await writeFile(temporary, bytes);
      await rename(temporary, file);
    }

    for (const [name, content] of extractTgz(bytes)) {
      if (!/^package\/(?:schemas\/|types\/|catalog\.json$|package\.json$|LICENSE$)/.test(name)) {
        continue;
      }

      const target = path.join(directory, name.slice('package/'.length));

      await safe(directory, target);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { name: string; version: string };

    if (manifest.name !== '@minecraft/bedrock-schemas' || manifest.version !== version) {
      throw new Error('Mojang schema SDK version mismatch for ' + version);
    }

    return await use(directory);
  } finally {
    await safe(root, directory);
    await rm(directory, { recursive: true, force: true });
  }
}

async function downloadSdk(version: string): Promise<Buffer> {
  const response = await fetch(`https://registry.npmjs.org/@minecraft/bedrock-schemas/-/bedrock-schemas-${version}.tgz`, {
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`Mojang schema SDK ${version} returned HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
