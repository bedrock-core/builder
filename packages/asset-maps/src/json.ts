export function serializeJson(value: unknown, pretty = true): string {
  if (typeof pretty !== 'boolean') {
    throw new TypeError('Asset-map pretty must be a boolean');
  }

  return JSON.stringify(value, null, pretty ? 2 : undefined) + '\n';
}

export const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
