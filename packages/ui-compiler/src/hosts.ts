import { glob, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonc } from './hooks.ts';
import { jsonText } from './output.ts';
import type { LinkedUi, UiSettings } from './types.ts';

interface Host {
  description: { identifier?: string; properties?: Record<string, unknown>; states?: Record<string, unknown> };
  components?: Record<string, Record<string, unknown>>;
}

/**
 * Resolve each container host across configured behavior packs and stamp its staged definition.
 * @param packs Configured pack IDs mapped to their directories.
 * @param linked Complete linked screen data for the current build.
 * @param settings UI output formatting and optional metadata settings.
 * @returns Paths of generated behavior-pack host/protocol definitions.
 */
export async function writeUiHosts(packs: string[], linked: LinkedUi, settings: UiSettings): Promise<string[]> {
  if (!linked.screens.some(screen => screen.host)) {
    return [];
  }

  const definitions = new Map<string, { pack: string; file: string; document: Record<string, unknown>; host: Host }>();
  const files: string[] = [];

  for (const pack of packs) {
    for await (const relative of glob(['entities/**/*.json', 'blocks/**/*.json'], { cwd: pack })) {
      const file = path.join(pack, relative);
      const document = parseJsonc(await readFile(file, 'utf8'));

      for (const kind of ['entity', 'block']) {
        const host = document[`minecraft:${kind}`] as Host | undefined;
        const identifier = host?.description.identifier;

        if (identifier && host) {
          const key = `${kind}:${identifier}`;

          if (definitions.has(key)) {
            throw new Error(`UI host ${identifier} has multiple definitions`);
          }

          definitions.set(key, { pack, file, document, host });
        }
      }
    }
  }

  const claimed = new Set<string>();
  const itemPacks = new Map<string, string>();

  for (const screen of linked.screens) {
    if (!screen.host) {
      continue;
    }

    const { kind, type } = screen.host;
    const key = `${kind}:${type}`;
    const target = definitions.get(key);

    if (claimed.has(key)) {
      throw new Error(`UI host ${type} is claimed by multiple screens`);
    }

    if (!target) {
      throw new Error(`Screen ${screen.name} names ${kind} ${type}, which is not in a configured behavior pack`);
    }

    claimed.add(key);
    const components = target.host.components ??= {};
    const size = screen.allocation!.size;

    if (kind === 'entity') {
      Object.assign(components['minecraft:inventory'] ??= {}, { container_type: 'container', inventory_size: size, private: false });
      (target.host.description.properties ??= {})[linked.layoutProperty] = { type: 'int', range: [0, linked.maxLayout], default: screen.layoutId };
    } else {
      if (components['minecraft:crafting_table']) {
        throw new Error(`UI host ${type} cannot combine minecraft:crafting_table and minecraft:block_entity`);
      }

      if (size > linked.blockSlotLimit) {
        throw new Error(`Screen ${screen.name} needs ${size} slots; blocks hold ${linked.blockSlotLimit}`);
      }

      Object.assign(components['minecraft:block_entity'] ??= {}, { container: { slot_count: size }, dynamic_properties: true });
      (target.host.description.states ??= {})[linked.layoutProperty] = [String(screen.layoutId), 'none'];
    }

    await writeFile(target.file, jsonText(target.document, settings.pretty));
    files.push(target.file);
    itemPacks.set(type.split(':')[0], target.pack);
  }

  for (const [namespace, pack] of itemPacks) {
    for (const item of linked.items[namespace] ?? []) {
      const file = path.join(pack, 'items/core-ui', namespace, `${item.role}.json`);

      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, jsonText(item.document, settings.pretty));
      files.push(file);
    }
  }

  return files;
}
