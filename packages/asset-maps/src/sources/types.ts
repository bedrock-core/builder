import type { InputFile } from './download.ts';
import type { ImagePixels } from './formats.ts';
import type { DefaultStates, InverseSources } from '../compiler/inverse.ts';
import type { EntityPart, ExtractedEntityModel } from '../compiler/entity.ts';
import type { JavaBlockstate, JavaModel, ModelSources, Triple } from '../compiler/types.ts';

export interface JavaArtifact extends InputFile { name: string; sha1: string; size: number }

export interface JavaSource {
  version: string; majorVersion: number; manifest: InputFile & { sha1: string }; client: JavaArtifact; libraries: JavaArtifact[];
}

export interface MappingSource { java: string; bedrock: string; version: string; archive: InputFile }

export interface Sources {
  schemaVersion: number;
  bedrock: { minecraft: string; channel: string; repository: string; tag: string; archive: InputFile; license: InputFile & { file: string } };
  java: JavaSource; mappings: MappingSource; policy: unknown;
}

export interface JavaManifest {
  id: string; javaVersion: { majorVersion: number };
  downloads: { client: Omit<JavaArtifact, 'name' | 'sha256'> };
  libraries: { name: string; rules?: { os?: unknown }[]; downloads: { artifact: Omit<JavaArtifact, 'name' | 'sha256'> & { path?: string } } }[];
}

export interface JavaResources {
  models: Record<string, JavaModel>; blockstates: Record<string, JavaBlockstate>; sprites: Map<string, ImagePixels>;
  image(resource: string): ImagePixels | undefined;
}

export interface Runtime { javaVersion: string; extractionRevision: string; blocks: DefaultStates['blocks']; models: Record<string, Record<string, { texture: [number, number]; root: EntityPart }>> }

export interface RendererPart { model: string; layer?: string; textureLocation?: string; nativeTexture?: string; when?: Record<string, string> }

export interface RendererBlock { parts: RendererPart[]; translation?: Triple; rotation?: { property: string; degrees?: Record<string, number>; step?: number } }

export interface RendererProfile {
  schemaVersion: number; java: string; client: string;
  models: Record<string, { transform: ExtractedEntityModel['transform']; layers: Record<string, { textureLocation?: string; render?: string }> }>;
  blocks: Record<string, RendererBlock>;
}

export interface RendererInputs {
  schemaVersion: number; minecraft: string;
  source: { schemaVersion: number; java: string; revision: string; client: JavaArtifact; profile: { file: string; contentSha256: string } };
  models: Record<string, ExtractedEntityModel>; blocks: Record<string, RendererBlock>; frameModels: Record<string, JavaModel>;
  textures: Record<string, string | { error: string }>;
}

export interface ReleaseAsset { name: string; browser_download_url: string; digest: string }

export interface Release { tag_name: string; draft?: boolean; prerelease?: boolean; body?: string; assets?: ReleaseAsset[] }

export interface VersionManifest { latest: { release: string; snapshot: string }; versions: { id: string; url: string; sha1: string }[] }

export interface SourceLock {
  schemaVersion: number; minecraft: string; channel: string;
  upstream: Pick<Sources['bedrock'], 'repository' | 'tag' | 'archive'>;
  conversion: ModelSources & {
    manifest: JavaSource['manifest']; client: JavaArtifact; mappingArchive: InputFile; extraction: string; nativeRevision: string;
    nativeCapture?: { bdsVersion: string; channel: 'stable' | 'preview' };
    inverse: InverseSources & { policy: Sources['policy'] }; renderers: RendererInputs['source'];
    sourcesSha256: string; textureRulesSha256: string;
  };
  authored: Record<string, string>;
}

export interface JavaAtlas { image: ImagePixels; rectangles: Record<string, [number, number, number, number]>; png: Buffer }

export interface TextureNames {
  mappings: Record<string, string>;
  resolve(value: string, dimensions?: readonly [number, number]): string | undefined;
}
