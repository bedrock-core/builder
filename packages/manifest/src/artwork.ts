import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveNamespace, resolveResourcePack, type BuildContext, type FeatureRouting } from '@bedrock-core/builder-plugin';

async function image(context: BuildContext, directory: string, relative: string): Promise<Buffer | undefined> {
  const file = path.resolve(directory, relative.endsWith('.png') ? relative : `${relative}.png`);
  const within = path.relative(directory, file);

  if (path.isAbsolute(within) || within === '..' || within.startsWith(`..${path.sep}`)) {
    throw new Error(`Artwork must stay inside its pack: ${relative}`);
  }

  context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, file)));

  try {
    const actual = await realpath(file);
    const resolved = path.relative(await realpath(directory), actual);

    if (path.isAbsolute(resolved) || resolved === '..' || resolved.startsWith(`..${path.sep}`)) {
      throw new Error(`Artwork must stay inside its pack: ${relative}`);
    }

    const bytes = await readFile(actual);

    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Artwork must be PNG: ${relative}`);
    }

    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

/** Copy each scripted addon's pack icon and thumbnail into its local resource textures. */
export async function prepareAddonArtwork(context: BuildContext, routing: FeatureRouting = {}): Promise<void> {
  const packs = await context.inspectPacks!();
  const owners = packs.filter(pack => pack.moduleTypes.includes('script') && typeof pack.manifest?.namespace === 'string');

  for (const owner of owners) {
    const local = new Set((owner.dependencies ?? []).flatMap(dependency => dependency.kind === 'local' ? [dependency.packId] : []));
    const candidates = packs.filter(pack => pack.moduleTypes.includes('resources') && local.has(pack.id));
    const thumbnail = owner.manifest?.thumbnail;

    if (!candidates.length) {
      if (thumbnail !== undefined) {
        throw new Error(`Pack ${owner.id} needs a local resource pack for thumbnail output`);
      }

      continue;
    }

    const ownerIcon = await image(context, owner.path, 'pack_icon.png');
    const resourceIcons = new Map(await Promise.all(candidates.map(async pack => [pack.id, await image(context, pack.path, 'pack_icon.png')] as const)));

    if (!ownerIcon && ![...resourceIcons.values()].some(Boolean) && thumbnail === undefined) {
      continue;
    }

    const selected = routing.owner === owner.id || (routing.owner === undefined && owners.length === 1) ? routing.resourcePack : undefined;
    const resource = resolveResourcePack(packs, owner, selected);
    const namespace = resolveNamespace(owner);

    for (const [field, source] of [['icon', 'pack_icon.png'], ['thumbnail', thumbnail]] as const) {
      if (typeof source !== 'string') {
        continue;
      }

      const bytes = field === 'icon'
        ? ownerIcon ?? resourceIcons.get(resource.id)
        : await image(context, owner.path, source) ?? await image(context, resource.path, source);

      if (!bytes) {
        if (field === 'thumbnail') {
          throw new Error(`Pack ${owner.id} thumbnail does not exist: ${source}`);
        }

        continue;
      }

      const texture = `textures/${namespace}/${field === 'icon' ? 'pack_icon' : 'thumbnail'}`;
      const destination = path.join(resource.path, `${texture}.png`);

      try {
        const existing = await readFile(destination);

        if (!existing.equals(bytes)) {
          throw new Error(`Artwork would overwrite a different texture: ${texture}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      await context.registerArtifact(`manifest:${owner.id}:${field}`, destination);

      if (field === 'thumbnail') {
        const file = path.join(owner.path, 'manifest.json');
        const text = await readFile(file, 'utf8');
        const manifest = JSON.parse(text) as Record<string, unknown>;

        manifest.thumbnail = texture;
        await writeFile(file, JSON.stringify(manifest, null, text.match(/\n([ \t]+)"/)?.[1]) + (text.endsWith('\n') ? '\n' : ''));
      }
    }
  }
}
