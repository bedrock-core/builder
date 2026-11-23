import type { ClientEntityDescription } from '@bedrock-core/bedrock-types';
import type { BlockStates, Vector3 } from '../compiler/types.ts';
import type { InverseRow } from '../compiler/inverse.ts';

export type JsonObject = Record<string, unknown>;
export type StateValue = string | number | boolean;
export type Side = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export type Triple = [number, number, number];
export interface Cube {
  origin: number[]; size: number[]; pivot?: number[]; rotation?: number[]; inflate?: number; mirror?: boolean;
  uv?: number[] | Partial<Record<Side, { uv: number[]; uv_size?: number[]; material_instance?: string }>>;
}

export interface Bone {
  name: string;
  parent?: string;
  pivot?: number[];
  rotation?: number[];
  mirror?: boolean;
  cubes?: Cube[];
  poly_mesh?: unknown;
  texture_meshes?: unknown[];
}

export interface Geometry {
  description: { identifier: string; texture_width?: number; texture_height?: number };
  bones: Bone[]; texturewidth?: number; textureheight?: number;
}

export interface Material { texture?: string; render_method?: string; [key: string]: unknown }

export interface Components extends JsonObject {
  'minecraft:geometry'?: string | { identifier: string; bone_visibility?: Record<string, boolean | string> };
  'minecraft:material_instances'?: Record<string, Material>;
  'minecraft:transformation'?: { rotation?: number[]; translation?: number[]; scale?: number[] };
  'minecraft:icon'?: { textures?: Record<string, string>; texture?: string };
  'minecraft:block_placer'?: { block: string };
}

export interface Definition {
  description: { identifier: string; states?: Record<string, StateValue[] | { values: { min: number; max: number } }> };
  components?: Components;
  permutations?: { condition: string | number; components: Components }[];
}

export interface EntityDocument { 'format_version'?: string; 'minecraft:client_entity': { description: ClientEntityDescription } }

export interface MetadataItem { name: string; serialization_id?: string; serialization_name?: string; properties?: { name: string }[] }

export interface Metadata { data_items: MetadataItem[]; block_properties: { name: string; values: { value: StateValue }[] }[] }

export interface AtlasEntry { textures: string | { path: string } | (string | { path: string })[]; [key: string]: unknown }

export interface Document extends JsonObject {
  [geometry: `geometry.${string}`]: Geometry;
  'format_version'?: string;
  'minecraft:block'?: Definition;
  'minecraft:item'?: Definition;
  'minecraft:client_entity'?: EntityDocument['minecraft:client_entity'];
  'minecraft:geometry'?: Geometry[];
  'texture_data'?: Record<string, AtlasEntry>;
  'data_items'?: MetadataItem[];
  'block_properties'?: Metadata['block_properties'];
}
export type Resources = Map<string, Document>;
export type BlockTextures = string | Partial<Record<Side | 'side' | '*', string>>;
export interface Block { 'format_version': string; 'minecraft:block': Definition; 'textures'?: BlockTextures; 'carried_textures'?: BlockTextures }

export interface Item { 'format_version': string; 'minecraft:item': Definition; 'textures'?: Record<string, { id: string }>; 'block'?: { id: string }; 'provenance'?: unknown }

export interface Model { geometry: Geometry; formatVersion?: string; provenance: { kind: string; warnings?: string[] } }

export interface Texture { paths: string[]; definition: unknown; flipbook?: JsonObject }

export interface Catalog {
  blocks: Record<string, Block>; items: Record<string, Item>; entities: Record<string, EntityDocument>;
  models: Record<string, Model>; textures: Record<string, Texture>;
}

export interface Bindings { minecraft?: string; blocks?: Record<string, string>; items?: Record<string, Record<string, string | { alias: string; index: number }>> }

export interface Problem {
  kind: string; id: string; reason: string; states?: BlockStates; stateTuples?: BlockStates[];
  affectedStates?: number; missingStates?: number; file?: string;
}

export interface Coverage {
  schemaVersion: number; minecraft: string; sourceBlockStates: number; generatedBlockStates: number; fallbackBlockStates: number;
  fallbacks: (Problem & { affectedStates: number; renderedStates: number })[];
  upstreamBlocks: string[]; authoredBlocks: string[]; resolvedAuthoredBlocks: string[]; authoredItems: string[];
  gaps: Problem[]; issues: Problem[]; approximations: { kind: string; id: string; reasons: string[] }[];
}

export interface NativeFace { origin: Vector3; u: Vector3; v: Vector3; uv: number[]; bone: string }

export interface GeometryContext { identifier: string; states: BlockStates }

export interface GeneratedDocuments { files: Resources; coverage: Coverage }

export interface GenerationSummary { documents: number; mappedStates: number; gaps: number; issues: number; pretty: boolean }
export type ModelSelection = Components | Error | undefined;
export interface NativeRendererAdapters {
  supports(id: string): boolean;
  block(id: string, states: BlockStates): ModelSelection;
}

export interface RendererAdapters {
  supports(id: string): boolean;
  supportsNative: NativeRendererAdapters['supports'];
  nativeBlock: NativeRendererAdapters['block'];
  block(id: string, states: BlockStates, row: Partial<InverseRow>): ModelSelection;
  entities(): void;
}
