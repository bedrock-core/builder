export interface TexturePathVariant {
  path: string;
  weight?: number;
  quad?: boolean | number;
  overlay_color?: string;
  tint_color?: string;
}

export interface TextureVariations {
  variations: TexturePathVariant[];
}

export type TextureAtlasTexture = string | TexturePathVariant | TextureVariations;

export interface TextureAtlasEntry {
  textures: TextureAtlasTexture | TextureAtlasTexture[];
  quad?: boolean | number;
  additive?: boolean;
  overlay_color?: string;
  tint_color?: string;
}

export type BlockTextureFace = '*' | 'up' | 'down' | 'north' | 'south' | 'east' | 'west' | 'side';
export type BlockTextureBindings = string | Partial<Record<BlockTextureFace, string>>;
