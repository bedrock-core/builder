export function createLootTable(item: string): LootTable {
  return {
    pools: [
      {
        rolls: 1,
        entries: [
          { type: 'item', name: item },
        ],
      },
    ],
  };
}
