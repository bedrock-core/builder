export type BlockStates = Readonly<Record<string, string | number | boolean>>;
export type RenderMaterial = 'opaque' | 'cutout' | 'blend' | 'emissive';
export interface Vector3 { x: number; y: number; z: number }

export interface RenderBox { min: Vector3; max: Vector3 }

export interface RenderFace { side?: Side; origin: Vector3; u: Vector3; v: Vector3; texture: number; uv: readonly [number, number, number, number]; material?: RenderMaterial; tint?: readonly [number, number, number, number]; repeat?: boolean }

export type Triple = readonly [number, number, number];
export type Side = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export const SIDES: readonly Side[] = ['north', 'south', 'east', 'west', 'up', 'down'];
export interface JavaFace { uv?: number[]; texture: string; rotation?: number; tintindex?: number; cullface?: Side }

export interface JavaElement { from: Triple; to: Triple; rotation?: { origin: Triple; axis: 'x' | 'y' | 'z'; angle: number; rescale?: boolean }; faces: Partial<Record<Side, JavaFace>> }

export interface JavaModel { parent?: string; textures?: Record<string, string | { sprite: string; force_translucent?: boolean }>; elements?: JavaElement[] }

export interface JavaApplication { model: string; x?: number; y?: number; uvlock?: boolean; weight?: number }
export type JavaCondition = { OR?: JavaCondition[]; AND?: JavaCondition[]; [key: string]: string | JavaCondition[] | undefined };
export interface JavaBlockstate { variants?: Record<string, JavaApplication | JavaApplication[]>; multipart?: { when?: JavaCondition; apply: JavaApplication | JavaApplication[] }[] }

export interface CheckedBlock { blockId: string; keys: string[]; values: (string | number | boolean)[][] }

export interface CheckedStates {
  version: string; revision: string; blocks: CheckedBlock[];
  capture?: { bdsVersion: string; channel: 'stable' | 'preview' };
}

export interface GeyserMapping { bedrock_identifier?: string; state?: Record<string, string | number> }

export interface ModelSources { java: string; bedrock: string; mappings: string; revision: string }

/** Position, U edge, V edge, UV rectangle, local material slot, tint, repeat, original Java side. */
export type PackedFace = number[];
export type Bounds = [number, number, number, number, number, number];
export interface ModelGeometry { faces: PackedFace[]; boxes: { bounds: Bounds; sides: number; slots: number[] }[] }

export interface ModelMaterial { texture: number; method: RenderMaterial; uv?: readonly [number, number, number, number]; warning?: string }

export interface ModelBinding { geometry: number; materials: number[]; occluders: number[]; name: string; warnings?: string[] }
export type ModelApplication = [model: number, x: number, y: number, uvlock: number, weight: number];
export interface ModelChoice { program: number; extra: BlockStates; java: string; facing?: string }

export interface ModelBlock {
  id: string; keys: string[]; domains: (string | number | boolean)[][];
  /** Sparse mixed-radix cell indices and indices into the shared choice pool. */
  indices: number[]; choices: number[]; connect?: 'fence' | 'pane' | 'wall';
}

export interface CompiledModelSource {
  schemaVersion: 1; source: ModelSources; provider: string;
  textures: string[]; materials: ModelMaterial[]; geometries: ModelGeometry[]; models: ModelBinding[];
  groups: ModelApplication[][]; programs: number[][]; choices: ModelChoice[][]; blocks: ModelBlock[];
}

export interface ModelCoverage {
  source: ModelSources; blocks: number; states: number; mappedStates: number; convertedStates: number; ambiguousStates: number;
  unmappedStates: number; missingModelStates: number; unsupportedStates: number;
  geometries: number; models: number; textures: number;
  exceptions: { blockId: string; total: number; converted: number; ambiguous: number; unmapped: number; missingModels: number; unsupported: number; reasons: string[] }[];
}
