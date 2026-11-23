import type { BlockStates } from './types.ts';

export const scalarKey = (value: unknown): string => String(typeof value === 'boolean' ? Number(value) : value);
export const stateKey = (keys: readonly string[], values: BlockStates): string => keys.map(key => scalarKey(values[key])).join('|');
