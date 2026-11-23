import type { SharedAssetCatalog } from '../assets.js';
export interface VanillaAssetOptions {
  targetVersion?: string;
  dependencyRoot?: string;
  mapsIndex?: string;
  nativeInputs?: string;
  nativePacks?: string | string[];
  cacheRoot?: string;
  offline?: boolean;
  resourcePack?: string;
  registerDependency?(file: string): void;
}
export function assetMapsIndex(projectRoot?: string): string;
export interface AssetMapDocuments { index: { schemaVersion: 1; minecraft: string; pretty?: boolean; files: Record<string, string> }; lock: object; documents: Map<string, object>; inputs: string[] }
export function readAssetMaps(indexFile: string): Promise<AssetMapDocuments>;
export function composeAssetMaps(maps: AssetMapDocuments, upstream: ReadonlyMap<string, unknown>, target?: string): SharedAssetCatalog;
export function generateVanillaAssets(options?: VanillaAssetOptions): Promise<{ catalog?: SharedAssetCatalog; inputs: string[]; files: string[]; unavailable?: string }>;
