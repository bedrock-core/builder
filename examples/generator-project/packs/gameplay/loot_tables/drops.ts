import drops from '../../../shared/drops.json' with { type: 'json' };
import { createLootTable } from '../../../shared/loot.ts';

type Drop = { id: string; item: string };

export default [
  drop => drop.id,
  drop => createLootTable(drop.item),
  drops,
] satisfies Many<Drop, LootTable>;
