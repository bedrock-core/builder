import type { Vector2, Vector3 } from '../common/primitives';

/** @see https://learn.microsoft.com/minecraft/creator/documents/camerasystem/cameracommandintroduction */
export interface CameraPresetDocument {
  'format_version': string;
  'minecraft:camera_preset': CameraPresetDefinition;
}

export interface CameraPresetDefinition {
  identifier: string;
  inherit_from?: string;
  pos_x?: number;
  pos_y?: number;
  pos_z?: number;
  rot_x?: number;
  rot_y?: number;
  radius?: number;
  starting_rot_x?: number;
  starting_rot_y?: number;
  view_offset?: Vector2;
  entity_offset?: Vector3;
  listener?: 'camera' | 'player';
  player_effects?: boolean;
  control_scheme?: CameraPresetControlScheme;
  aim_assist?: CameraPresetAimAssist;
}

/** @see https://learn.microsoft.com/minecraft/creator/documents/controlschemes */
export type CameraPresetControlScheme
  = 'camera_relative'
    | 'camera_relative_strafe'
    | 'player_relative'
    | 'player_relative_strafe'
    | 'locked_player_relative_strafe';

/** @see https://learn.microsoft.com/minecraft/creator/documents/camerasystem/aimassistpresets */
export interface CameraPresetAimAssist {
  preset?: string;
  target_mode?: 'angle' | 'distance';
  angle?: Vector2;
  distance?: number;
}
