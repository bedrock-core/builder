import { BlockPermutation, BlockStates, BlockTypes, system } from '@minecraft/server';
import { register } from '@minecraft/server-gametest';

type State = string | number | boolean;
declare const nativeBlocks: string[];

const report = (row: object): void => console.warn('ASSET_MAP_STATES ' + JSON.stringify(row));

register('builder_asset_maps', 'capture_states', (test) => {
  system.runJob((function* () {
    try {
      const available = new Set(BlockTypes.getAll().map(block => block.id));
      let attempts = 0;

      for (const blockId of nativeBlocks) {
        if (!available.has(blockId)) {
          report({ blockId, unavailable: true });
          continue;
        }

        const keys = Object.keys(BlockPermutation.resolve(blockId).getAllStates()).sort();
        const domains = keys.map(key => BlockStates.get(key)?.validValues ?? []);
        const size = domains.reduce((count, domain) => count * domain.length, 1);
        const seen = new Set<string>();
        let batch: State[][] = [];

        if (!size || size > 100_000) {
          throw new Error('Cannot enumerate native state domains of ' + blockId);
        }

        for (let index = 0; index < size; index++) {
          let remainder = index;
          const state: Record<string, State> = {};

          for (let axis = keys.length - 1; axis >= 0; axis--) {
            state[keys[axis]] = domains[axis][remainder % domains[axis].length];
            remainder = Math.floor(remainder / domains[axis].length);
          }

          let actual: Record<string, State> | undefined;

          try {
            actual = BlockPermutation.resolve(blockId, state).getAllStates();
          } catch { /* A global property value can be invalid for this block. */ }

          if (actual) {
            const tuple = keys.map(key => actual[key]), signature = JSON.stringify(tuple);

            if (!seen.has(signature)) {
              seen.add(signature);
              batch.push(tuple);
            }
          }

          if (batch.length === 16) {
            report({ blockId, keys, values: batch });
            batch = [];
          }

          if (++attempts % 128 === 0) {
            yield;
          }
        }

        if (batch.length) {
          report({ blockId, keys, values: batch });
        }

        if (!seen.size) {
          throw new Error('No native states were resolved for ' + blockId);
        }
      }

      test.succeed();
    } catch (error) {
      test.fail(String(error));
    }
  })());
}).structureName('builder_asset_maps:empty').tag('builder_asset_maps').maxTicks(2400);
