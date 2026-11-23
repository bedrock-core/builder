import { parseArgs } from 'node:util';
import { resolveSourcePins } from './sources/pins.ts';
import { applySourcePin } from './update.ts';
import { readAssetRelease } from './releases.ts';

const { values } = parseArgs({
  options: {
    bedrock: { type: 'string' },
    java: { type: 'string' },
    mappings: { type: 'string' },
    channel: { type: 'string' },
    apply: { type: 'boolean' },
    states: { type: 'string' },
  },
});
const current = await readAssetRelease();
const candidate = await resolveSourcePins({
  current: current.source,
  bedrock: values.bedrock,
  java: values.java,
  mappings: values.mappings,
  channel: values.channel,
});
const result = values.apply
  ? await applySourcePin(candidate, current.version, values.states)
  : candidate;

console.info(JSON.stringify(result, null, 2));
