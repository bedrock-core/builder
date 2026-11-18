import type { GeometryDocument } from './geometry';

export type ModelGeometry = NonNullable<GeometryDocument['minecraft:geometry']>[number];
export type ModelDescription = NonNullable<ModelGeometry['description']>;
export type ModelBone = NonNullable<ModelGeometry['bones']>[number];
export type ModelCube = NonNullable<ModelBone['cubes']>[number];
export type ModelCubeUV = NonNullable<ModelCube['uv']>;
export type ModelFaceUVs = Exclude<ModelCubeUV, readonly unknown[]>;
export type ModelFaceUV = NonNullable<ModelFaceUVs['north']>;
export type ModelLocator = NonNullable<ModelBone['locators']>[string];

export type ItemDisplayContext = 'gui' | 'ground' | 'fixed' | 'head' | 'firstperson_righthand' | 'firstperson_lefthand' | 'thirdperson_righthand' | 'thirdperson_lefthand';

export interface ItemDisplayTransform {
  fit_to_frame?: boolean;
  rotation?: [number, number, number];
  translation?: [number, number, number];
  scale?: [number, number, number];
  rotation_pivot?: [number, number, number];
  scale_pivot?: [number, number, number];
}

export type ItemDisplayTransforms = Partial<Record<ItemDisplayContext, ItemDisplayTransform>>;

/** Named geometry body used by the native 1.8 format. */
export interface LegacyModelGeometry {
  texturewidth?: number;
  textureheight?: number;
  visible_bounds_width?: number;
  visible_bounds_height?: number;
  visible_bounds_offset?: [number, number, number];
  debug?: boolean;
  cape?: string;
  bones?: LegacyModelBone[];
}

export type LegacyModelBone = Omit<ModelBone, 'cubes'> & {
  cubes?: LegacyModelCube[];
  neverRender?: boolean;
  reset?: boolean;
  bind_pose_rotation?: [number, number, number];
};

export type LegacyModelCube = Omit<ModelCube, 'uv'> & { uv?: [number, number] };
