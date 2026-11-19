/**
 * Server-side metadata keyed by sound event name.
 * @see https://github.com/Blockception/Minecraft-bedrock-json-schemas/blob/main/source/behavior/sounds/server_sound_definitions.json
 */
export interface ServerSoundDefinitionsDocument {
  'format_version'?: string;
  'minecraft:server_sound_definitions': ServerSoundDefinition[];
}

export interface ServerSoundDefinition {
  sound_event_name: string;
  duration_info?: { mode: 'game_time' | 'real_time'; seconds: number };
  music_info?: {
    artist?: string;
    title?: string;
    genres?: string[];
    moods?: string[];
  };
  tags?: Record<string, string | string[]>;
  broadcast_range?: number;
}
