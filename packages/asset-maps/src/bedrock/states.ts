import { createHash } from 'node:crypto';
import type { CheckedBlock, CheckedStates } from '../compiler/types.ts';
import type { Metadata, StateValue } from './types.ts';

/** Merge observed tuples using current Mojang property names, excluding deprecated aliases and failed captures. */
export function mergeStateCapture(base: CheckedStates, captured: { version: string; blocks: (CheckedBlock & { error?: string })[] }, metadata: Metadata): CheckedStates {
  if (captured.version !== base.version) {
    throw new Error('Captured states and the checked palette must use the same Bedrock release');
  }

  const known = new Map(base.blocks.map(block => [block.blockId, block]));
  const definitions = new Map(metadata.data_items.map(block => [block.name, block]));
  const domains = new Map(metadata.block_properties.map(property => [property.name, property.values.map(value => value.value)]));

  for (const row of captured.blocks) {
    if (row.error || known.has(row.blockId)) {
      continue;
    }

    const definition = definitions.get(row.blockId);

    if (!definition) {
      throw new Error('Captured block is absent from the pinned Mojang inventory: ' + row.blockId);
    }

    const allowed = new Set((definition.properties ?? []).map(property => property.name));
    const keys = row.keys.filter(key => allowed.has(key)).sort();
    const values = new Map<string, StateValue[]>();

    for (const tuple of row.values) {
      const projected = keys.map(key => tuple[row.keys.indexOf(key)]);

      if (tuple.length !== row.keys.length || projected.some((value, i) => !domains.get(keys[i])?.includes(value))) {
        throw new Error('Captured state differs from the pinned Mojang property domain: ' + row.blockId);
      }

      values.set(JSON.stringify(projected), projected);
    }

    if (!values.size) {
      throw new Error('Captured block has no legal state tuples: ' + row.blockId);
    }

    known.set(row.blockId, { blockId: row.blockId, keys, values: [...values.values()] });
  }

  const blocks = [...known.values()].sort((a, b) => a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0);
  const revision = createHash('sha256').update(JSON.stringify({ version: base.version, blocks })).digest('hex');

  return { ...base, revision, blocks };
}
