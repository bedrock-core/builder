export function selectedPackAsset(name: string): boolean;
export function parsePackJson(text: string): unknown;
export function readPackAssets(directory: string, onFile?: (file: string) => void): Promise<Map<string, unknown>>;
