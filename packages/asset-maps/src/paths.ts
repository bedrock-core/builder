import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const distribution = path.join(root, 'dist');
export const data = path.join(root, 'data');
export const cache = path.join(root, '.bedrock-core/cache/asset-maps/inputs');
export const reports = path.join(root, '.bedrock-core');
