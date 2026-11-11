import { core } from '@bedrock-core/server-runtime';
import { ContainerSlot, ItemStack, system, world } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import * as provider from '@prototype/native-access-provider';
import { nativeAccess } from './runtime';
import manifest from '../manifest.json';
core.register({ manifest });
const wait = (): Promise<void> => new Promise(resolve => system.run(resolve));

function position(test: Test) {
  const point = test.worldLocation({ x: 1, y: 2, z: 1 });

  world.getDimension('overworld').getBlock({ x: point.x, y: point.y - 1, z: point.z })!.setType('minecraft:stone');

  return point;
}

export async function reference(test: Test): Promise<void> {
  const point = position(test);
  const id = await provider.create(point.x, point.y, point.z, 'reference');

  try {
    await provider.write(id, 3, 'minecraft:stone', 4);
    const before = JSON.parse(await provider.snapshot(id, 3)) as {
      typeId: string;
      amount: number;
    };

    for (const variant of ['slot', 'destructured', 'bound', 'borrowed', 'namespace', 'library', 'dependency', 'javascript', 'javascript_optional', 'javascript_bound', 'javascript_destructured', 'javascript_parenthesized', 'javascript_optional_parenthesized', 'commonjs', 'erased', 'erased_bound', 'rebound', 'optional', 'optional_bound', 'optional_method', 'parenthesized_method', 'parenthesized_optional', 'parenthesized_required', 'callback', 'native_callback']) {
      const encoded = await provider.slot(id, 3, variant);
      const value = nativeAccess.decode(JSON.parse(encoded));

      test.assert(value instanceof ContainerSlot, `${variant}: receiver gets a real native slot`);

      if (!(value instanceof ContainerSlot)) {
        throw new Error('not a native slot');
      }

      test.assert(Object.getPrototypeOf(value) === ContainerSlot.prototype, `${variant}: native prototype is preserved`);
      value.setItem(new ItemStack('minecraft:diamond', 7));
      const after = JSON.parse(await provider.snapshot(id, 3)) as {
        typeId: string;
        amount: number;
      };

      test.assert(after.typeId === 'minecraft:diamond' && after.amount === 7, `${variant}: receiver writes reach provider inventory`);
      test.assert(await provider.echo(JSON.stringify(nativeAccess.encode(value))) === encoded, `${variant}: forwarding preserves lookup provenance`);
    }

    test.assert(before.typeId === 'minecraft:stone' && before.amount === 4, 'Produced data does not become a later query');
    test.assert((await provider.rawSnapshot(id, 3)).includes('non-replayable'), 'Item copies are not replayed as live lookups');
    test.assert(world.getDimension('overworld').getEntities({ tags: ['native-access:reference'] }).length === 1, 'Reconstruction never repeats spawnEntity');
    const recipe = JSON.parse(await provider.slot(id, 3)) as {
      path: {
        operation: string;
        args: unknown[];
      }[];
    };

    recipe.path.push({ operation: 'Entity.remove', args: [] });
    let rejected = false;

    try {
      nativeAccess.decode(recipe);
    } catch {
      rejected = true;
    }

    test.assert(rejected && world.getEntity(id)?.isValid === true, 'Mutation operations cannot be replayed');
    const live = await provider.slot(id, 3);

    await provider.remove(id);
    rejected = false;

    try {
      nativeAccess.decode(JSON.parse(live));
    } catch {
      rejected = true;
    }

    test.assert(rejected, 'Removed owners reject reconstruction');
  } finally {
    if (world.getEntity(id)?.isValid) {
      await provider.remove(id);
    }
  }
}

async function benchmark(test: Test): Promise<void> {
  const point = position(test);
  const id = await provider.create(point.x, point.y, point.z, 'benchmark');
  const direct: number[] = [];
  const tracked: number[] = [];
  const loops = 2000;

  try {
    await provider.measure(id, 200, false);
    await provider.measure(id, 200, true);

    for (let index = 0; index < 7; index++) {
      const order = index % 2 ? [true, false] : [false, true];

      for (const enabled of order) {
        const elapsed = await provider.measure(id, loops, enabled);

        (enabled ? tracked : direct).push(elapsed);
        await wait();
      }
    }

    console.warn(`NATIVE_ACCESS_BENCH ${JSON.stringify({ loops, direct, tracked })}`);
    test.assert(direct.length === 7 && tracked.length === 7, 'Matched alternating native samples completed');
  } finally {
    await provider.remove(id);
  }
}

for (const [name, run] of [['reference', reference], ['benchmark', benchmark]] as const) {
  register('native_access', name, (test) => {
    void run(test).then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
  })
    .structureName('native_access:empty').tag('native_access').maxTicks(600);
}
