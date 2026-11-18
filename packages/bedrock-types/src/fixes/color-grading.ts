import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SchemaNode } from '../schema/normalize.ts';

/** Describe the client color-grading document and its tonal ranges. */
export async function normalizeColorGrading(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/deferred_rendering/color_grading.schema.json');
  const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
  const channels = { contrast: vector, gain: vector, gamma: vector, offset: vector, saturation: vector };
  const range = (threshold: string): SchemaNode => ({
    type: 'object',
    properties: { ...channels, enabled: { type: 'boolean' }, [threshold]: { type: 'number' } },
    required: ['enabled'],
  });

  // https://learn.microsoft.com/minecraft/creator/documents/vibrantvisuals/colorgradingtonemappingcustomization
  const document = {
    type: 'object',
    properties: {
      'format_version': { type: 'string' },
      'minecraft:color_grading_settings': {
        type: 'object',
        properties: {
          description: { type: 'object', properties: { identifier: { type: 'string' } }, required: ['identifier'] },
          color_grading: {
            type: 'object',
            properties: {
              midtones: { type: 'object', properties: channels },
              shadows: range('shadowsMax'),
              highlights: range('highlightsMin'),
              temperature: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  temperature: { type: 'number' },
                  type: { enum: ['white_balance', 'color_temperature'] },
                },
                required: ['enabled'],
              },
            },
            required: ['midtones'],
          },
          tone_mapping: {
            type: 'object',
            properties: { operator: { enum: ['reinhard', 'reinhard_luma', 'reinhard_luminance', 'hable', 'aces', 'generic'] } },
            required: ['operator'],
          },
        },
        required: ['description'],
      },
    },
    required: ['format_version', 'minecraft:color_grading_settings'],
  };

  await writeFile(file, JSON.stringify(document));
}
