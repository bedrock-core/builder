import { system } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import * as provider from '@prototype/native-access-provider';
import { reference } from './consumer';

async function benchmark(test: Test): Promise<void> {
  const point = test.worldLocation({ x: 1, y: 2, z: 1 });
  const id = await provider.create(point.x, point.y, point.z, 'qualification');
  const cases = [];
  const loops = 20_000;

  try {
    for (const variant of ['typescript', 'esm', 'commonjs']) {
      const direct: number[] = [];
      const tracked: number[] = [];
      const order: boolean[][] = [];

      await provider.measureVariant(id, 2000, false, variant);
      await provider.measureVariant(id, 2000, true, variant);

      for (let index = 0; index < 7; index++) {
        const sequence = index % 2 ? [true, false] : [false, true];

        order.push(sequence);

        for (const enabled of sequence) {
          const elapsed = await provider.measureVariant(id, loops, enabled, variant);

          (enabled ? tracked : direct).push(elapsed);
          await new Promise<void>(resolve => system.run(resolve));
        }
      }

      cases.push({ variant, loops, direct, tracked, order });
    }

    console.warn(`NATIVE_ACCESS_QUALIFICATION ${JSON.stringify({ cases })}`);
    test.assert(cases.length === 3 && cases.every(item => item.direct.length === 7 && item.tracked.length === 7), 'All matched native variants completed');
  } finally {
    await provider.remove(id);
  }
}

register('native_qualification', 'acceptance', (test) => {
  void (async () => {
    await reference(test);
    await benchmark(test);
  })().then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
})
  .structureName('native_access:empty').tag('native_qualification').maxTicks(1800);
