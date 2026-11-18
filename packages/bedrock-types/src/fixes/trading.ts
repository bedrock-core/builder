import { declarationEdits } from '../schema/patch.ts';

/** Use the SDK trade document and share item and choice shapes across tiers and groups. */
export function normalizeTrading(upstream: string): string {
  const edits = declarationEdits(upstream);

  edits.replace('TradeTable', `
export interface TradingDocument {
  format_version?: string;
  tiers: TradeTier[];
  weight?: number;
}`);
  edits.members('TradeTableTiers', { groups: 'TradeGroup[]', trades: 'Trade[]' });
  edits.members('TradeTableTiersGroups', { trades: 'Trade[]' });
  edits.members('TradeTableTiersTrades', { wants: '[TradeEntry] | [TradeEntry, TradeEntry]', gives: '[TradeEntry]' });

  for (const name of [
    'TradeTableTiersGroupsTrades', 'TradeTableTiersGroupsTradesGives', 'TradeTableTiersGroupsTradesWants',
    'TradeTableTiersTradesGives', 'TradeTableTiersTradesWants',
  ]) {
    edits.replace(name, '');
  }

  return edits.finish(
    { TradeTableTiers: 'TradeTier', TradeTableTiersGroups: 'TradeGroup', TradeTableTiersTrades: 'Trade' },
    'import type { LootFunction } from \'./table\';\nimport type { JsonValue } from \'../common/primitives\';\n',
    `
export type TradeQuantity = number | { min?: number; max?: number };

export interface TradeItem {
  item: string;
  quantity?: TradeQuantity;
  price_multiplier?: number;
  filters?: Record<string, JsonValue> | JsonValue[];
  functions?: LootFunction[];
}

export type TradeEntry = TradeItem | { choice: [TradeItem, ...TradeItem[]] };
`,
  );
}
