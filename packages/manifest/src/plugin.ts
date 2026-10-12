import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext, BuildDetection } from '@bedrock-core/builder-plugin';
import { resolveManifest, resolveProjectManifests, type ManifestSettings } from './index.ts';

/** Resolve selected manifests in staging, then remove pack-root manifest variants. */
export async function run(context: BuildContext, settings: ManifestSettings): Promise<void> {
  const sources = new Map(Object.entries(context.packs).map(([id, directory]) => [id, path.join(directory, 'manifest.json')]));
  const requested = settings.manifestPath === undefined ? [] : Array.isArray(settings.manifestPath) ? settings.manifestPath : [settings.manifestPath];

  if (settings.manifestPath !== undefined && requested.length === 0) {
    throw new Error('manifestPath must name at least one manifest');
  }

  const selected = new Set<string>();

  for (const entry of requested) {
    const file = path.resolve(context.stagedRoot, entry);
    const pack = Object.entries(context.packs).find(([, directory]) => path.relative(directory, path.dirname(file)) === '');

    if (!pack) {
      throw new Error(`Manifest source must be at a configured pack root: ${entry}`);
    }

    if (selected.has(pack[0])) {
      throw new Error(`Two manifestPath entries select the same pack: ${pack[0]}`);
    }

    selected.add(pack[0]);
    sources.set(pack[0], file);
  }

  const resolved = [];

  for (const [id, source] of sources) {
    const result = await resolveManifest(source, { root: context.stagedRoot, signal: context.signal, validate: !context.project });
    const directory = context.packs[id];
    const variants = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^manifest\..+\.json$/.test(entry.name))
      .map(entry => path.join(directory, entry.name));

    resolved.push({ id, directory, variants, ...result });
  }

  const pretty = settings.pretty;
  const manifests = context.project && resolveProjectManifests(Object.fromEntries(resolved.map(item => [item.id, item.manifest])), context.project);
  const indent = pretty === undefined || pretty === false
    ? undefined
    : (pretty.indent === 'tab' ? '\t' : ' ').repeat(pretty.size ?? (pretty.indent === 'tab' ? 1 : 2));

  for (const { id, directory, variants, manifest, inputs } of resolved) {
    context.signal?.throwIfAborted();
    const file = path.join(directory, 'manifest.json');
    const content = JSON.stringify(manifests?.[id] ?? manifest, null, indent);

    await writeFile(file, indent === undefined ? content : `${content}\n`);

    for (const variant of variants) {
      await unlink(variant);
    }

    for (const input of inputs) {
      context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, input)));
    }

    await context.registerArtifact(`manifest:${id}`, file);

    if (context.project) {
      const texts = path.join(directory, 'texts');
      const lang = path.join(texts, 'en_US.lang');
      let text = '';

      try {
        text = await readFile(lang, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      const lines = Object.entries({ 'pack.name': context.project.name, 'pack.description': context.project.description })
        .filter(([key]) => Object.values((manifests?.[id] ?? manifest).header as Record<string, unknown>).includes(key))
        .filter(([key]) => !(new RegExp(`^${key.replaceAll('.', '\\.')}=`, 'm')).test(text))
        .map(([key, value]) => `${key}=${value.replaceAll('\r', ' ').replaceAll('\n', ' ')}`);

      if (lines.length) {
        await mkdir(texts, { recursive: true });
        await writeFile(lang, `${text.trimEnd()}\n${lines.join('\n')}\n`);
      }
    }
  }
}

/** Detect configured manifests without evaluating pack scripts. */
export function detect(context: BuildContext): BuildDetection {
  const needed = Object.keys(context.packs).length > 0;

  return { needed, reason: `${needed ? 'Found' : 'No'} configured pack manifests` };
}
