import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext, BuildPlugin, BundleExtension, CacheOptions, LinkedPacks, PackInfo } from '@bedrock-core/builder-plugin';
import type { ModulePluginDefinition } from './config.ts';
import { resolvePluginPacks } from './plugin-packs.ts';

/** Preserve live host services while exposing one declared invocation's pack paths. */
export function packContext(
  context: BuildContext, packs: readonly PackInfo[], owner?: PackInfo,
  linkedPacks: LinkedPacks = Object.freeze({}), owners = packs.map(pack => pack.id), routing?: unknown,
): BuildContext {
  return Object.freeze({
    ...context,
    get generatedImports() { return owner && context.generatedImportsFor ? context.generatedImportsFor(owner.id) : context.generatedImports; },
    get inputDirectories() { return context.inputDirectories; },
    get bundleExtensions() { return context.bundleExtensions; },
    reuse<T>(id: string, options: CacheOptions<T>) {
      return context.reuse(id, routing === undefined ? options : { ...options, key: { routing, plugin: options.key ?? null } });
    },
    registerBundleExtension(extension: BundleExtension) {
      context.registerBundleExtension({ ...extension, packs: extension.packs ?? owners });
    },
    packs: Object.freeze(Object.fromEntries(packs.map(pack => [pack.id, pack.path]))),
    outputPaths: Object.freeze(Object.fromEntries(packs.map(pack => [pack.id, context.outputPaths[pack.id]!]))),
    ...(owner ? { pack: owner } : {}),
    linkedPacks,
  });
}

/** Resolve all owners and dependency overrides before invoking a native plugin. */
export function nativePluginContexts(
  context: BuildContext, plugin: BuildPlugin, definition: ModulePluginDefinition, graph: readonly PackInfo[],
): readonly BuildContext[] {
  if (plugin.requirements === undefined) {
    if (definition.packs !== undefined || definition.links !== undefined || definition.scope === 'pack') {
      throw new Error('Native pack plugins must export requirements.modules before selecting packs or links');
    }

    return [context];
  }

  const resolved = resolvePluginPacks(graph, plugin.requirements, definition.packs, definition.links);
  const routing = { requirements: plugin.requirements, graph: graph.map(pack => ({ id: pack.id, manifest: pack.manifest })), links: resolved.map(({ pack, linkedPacks }) => ({ owner: pack.id, links: Object.fromEntries(Object.entries(linkedPacks).map(([name, packs]) => [name, packs.map(pack => pack.id)])) })) };

  if (definition.scope !== 'project') {
    return resolved.map(invocation => packContext(context, invocation.packs, invocation.pack, invocation.linkedPacks, [invocation.pack.id], routing));
  }

  if (!resolved.length) {
    return [];
  }

  const selected = new Map(resolved.flatMap(invocation => invocation.packs).map(pack => [pack.id, pack]));
  const names = Object.keys(plugin.requirements.dependencies ?? {});
  const links = Object.freeze(Object.fromEntries(names.map(name => [name, Object.freeze([...new Map(resolved.flatMap(invocation => invocation.linkedPacks[name] ?? []).map(pack => [pack.id, pack])).values()])])));

  return [packContext(context, [...selected.values()], undefined, links, resolved.map(invocation => invocation.pack.id), routing)];
}

interface FileState { pack: string; file: string; hash: string }

/** Detect overlapping edits when several owner invocations share a destination pack. */
export function sharedPackWrites(invocations: readonly BuildContext[], plugin: string): {
  snapshot(context: BuildContext): Promise<Map<string, FileState>>;
  verify(context: BuildContext, before: Map<string, FileState>): Promise<void>;
} {
  const counts = new Map<string, number>();
  const writers = new Map<string, string>();

  for (const invocation of invocations) {
    for (const id of Object.keys(invocation.packs)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  async function snapshot(context: BuildContext): Promise<Map<string, FileState>> {
    const files = new Map<string, FileState>();

    async function visit(pack: string, root: string, directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);

        if (entry.isSymbolicLink()) {
          throw new Error(`Plugin ${plugin} produced a symlink in shared pack ${pack}`);
        }

        if (entry.isDirectory()) {
          await visit(pack, root, file);
        } else {
          files.set(file, { pack, file: path.relative(root, file), hash: createHash('sha256').update(await readFile(file)).digest('hex') });
        }
      }
    }

    for (const [id, directory] of Object.entries(context.packs)) {
      if ((counts.get(id) ?? 0) > 1) {
        await visit(id, directory, directory);
      }
    }

    return files;
  }

  return {
    snapshot,
    async verify(context, before) {
      const after = await snapshot(context);
      const owner = context.pack?.id ?? 'project';

      for (const file of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(file)?.hash === after.get(file)?.hash) {
          continue;
        }

        const previous = writers.get(file);
        const state = after.get(file) ?? before.get(file)!;

        if (previous !== undefined && previous !== owner) {
          throw new Error(`Plugin ${plugin} owners ${previous} and ${owner} both modify shared pack ${state.pack}/${state.file}; select distinct destinations or use one project-scoped invocation`);
        }

        writers.set(file, owner);
      }
    },
  };
}
