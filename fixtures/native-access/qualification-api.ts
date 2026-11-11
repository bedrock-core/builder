export * from './provider-api';
import { world, type ContainerSlot, type Entity } from '@minecraft/server';
import * as authored from './authored';
import * as baseline from './baseline';
import * as directJavaScript from '@prototype/native-access-js-control';
import { compiledCjs as directCommonJs } from '@prototype/native-access-js-control/commonjs';
import { nativeAccess } from './runtime';

type Lookup = (entity: Entity, index: number) => ContainerSlot;
const variants: Record<string, { direct: Lookup; tracked: Lookup }> = {
  typescript: { direct: baseline.slot, tracked: authored.slot },
  esm: { direct: directJavaScript.compiledSlot, tracked: authored.compiledSlot },
  commonjs: { direct: directCommonJs, tracked: authored.compiledCjs },
};

/** Time native acquisition in the provider; transport and recipe encoding are outside the timer. */
export async function measureVariant(id: string, loops: number, tracked: boolean, variant: string): Promise<number> {
  const owner = world.getEntity(id);
  const selected = variants[variant];

  if (!owner?.isValid || !selected) {
    throw new Error('benchmark owner or variant is unavailable');
  }

  const run = tracked ? selected.tracked : selected.direct;
  let last: ContainerSlot | undefined;
  const start = Date.now();

  for (let index = 0; index < loops; index++) {
    last = run(owner, index % 9);
  }

  const elapsed = Date.now() - start;

  if (!last?.isValid) {
    throw new Error('benchmark did not retain a valid native slot');
  }

  if (tracked && nativeAccess.encode(last).path.length !== 3) {
    throw new Error('benchmark did not capture the inventory lookup');
  }

  return elapsed;
}
