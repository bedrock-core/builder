import type { MolangExpression, Vector2 } from '../common/primitives';

export type FeaturePlacementPass
  = 'first_pass'
    | 'before_underground_pass'
    | 'underground_pass'
    | 'after_underground_pass'
    | 'before_surface_pass'
    | 'surface_pass'
    | 'after_surface_pass'
    | 'before_sky_pass'
    | 'sky_pass'
    | 'after_sky_pass'
    | 'final_pass';

/** An offset, a Molang expression, or a distribution of offsets along one axis. */
export type ScatterCoordinate = MolangExpression | {
  distribution: 'uniform' | 'gaussian' | 'inverse_gaussian' | 'triangle' | 'fixed_grid' | 'jittered_grid';
  extent: Vector2;
  grid_offset?: number;
  step_size?: number;
};

/** Placement coordinates evaluated for each scatter iteration. */
export interface ScatterDistribution {
  iterations: MolangExpression;
  /** Evaluated once before attempting any placements. */
  scatter_chance?: MolangExpression | { numerator: number; denominator: number };
  coordinate_eval_order?: 'xyz' | 'xzy' | 'yxz' | 'yzx' | 'zxy' | 'zyx';
  x: ScatterCoordinate;
  y: ScatterCoordinate;
  z: ScatterCoordinate;
}
