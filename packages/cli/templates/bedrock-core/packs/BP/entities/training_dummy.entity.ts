import type { EntityDocument } from '@bedrock-core/bedrock-types';

/**
 * Generator SINGLE-FILE pattern: a default-exported object becomes one .json
 * file with the same basename (training_dummy.entity.json).
 *
 * `satisfies EntityDocument` checks it against Mojang's official entity schema —
 * components autocomplete from the published Bedrock document types.
 */
import manifest from '../manifest.json';

export default {
  'format_version': '1.21.0',
  'minecraft:entity': {
    description: {
      identifier: `${manifest.namespace}:training_dummy`,
      is_summonable: true,
      is_spawnable: false,
      is_experimental: false,
    },
    components: {
      'minecraft:health': { value: 20, max: 20 },
      'minecraft:nameable': {},
      'minecraft:collision_box': { width: 0.6, height: 1.8 },
      'minecraft:physics': {},
    },
  },
} satisfies EntityDocument;
