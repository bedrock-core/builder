import { core } from '@bedrock-core/server-runtime';
import { ContainerSlot, ItemStack, system, world } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import * as provider from '@prototype/native-access-provider';
import { nativeAccess } from './runtime';
import manifest from '../manifest.json';

core.register({ manifest });
const wait = (ticks: number): Promise<void> => new Promise(resolve => system.runTimeout(resolve, ticks));

function inspect(slot: ContainerSlot): { valid: boolean; typeId?: string; amount?: number; error?: string } {
  try {
    if (!slot.isValid) {
      return { valid: false };
    }

    const item = slot.getItem();

    return { valid: true, typeId: item?.typeId, amount: item?.amount };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}

async function lifetime(test: Test): Promise<void> {
  const point = test.worldLocation({ x: 1, y: 2, z: 1 });
  const dimension = world.getDimension('overworld');
  const block = dimension.getBlock(point)!;
  const restore = block.permutation;
  let entityId: string | undefined;
  let providerStopped = false;
  const observed: Record<string, unknown> = {};
  const stopped = system.afterEvents.scriptEventReceive.subscribe((event) => {
    if (event.id === 'native_access:provider_stopped') {
      const value = JSON.parse(event.message) as { registered: boolean };

      providerStopped = !value.registered;
    }
  });

  try {
    const local = test.spawn('minecraft:chest_minecart', { x: 2, y: 2, z: 1 });

    try {
      const component = local.getComponent('minecraft:inventory')!;
      const slot = component.container.getSlot(3);

      observed.entityComponentLocator = { owner: component.entity.id, component: component.typeId };
      test.assert(component.entity.id === local.id && component.typeId === 'minecraft:inventory', 'Entity components expose their owner and component ID');
      let rejected = false;

      try {
        nativeAccess.encode(slot);
      } catch {
        rejected = true;
      }

      observed.untrackedLocalSlotRejected = rejected;
      test.assert(rejected, 'Locally acquired slots need provenance before transfer');
    } finally {
      local.remove();
    }

    block.setType('minecraft:chest');
    await wait(2);
    const blockComponent = block.getComponent('minecraft:inventory')!;
    const retainedContainer = blockComponent.container!;

    observed.blockComponentLocator = { dimension: blockComponent.block.dimension.id, ...blockComponent.block.location, component: blockComponent.typeId };
    test.assert(blockComponent.block.location.x === point.x && blockComponent.typeId === 'minecraft:inventory', 'Block components expose their location and component ID');
    const blockRecipe = await provider.blockSlot(point.x, point.y, point.z, 3);
    const original = nativeAccess.decode(JSON.parse(blockRecipe));

    if (!(original instanceof ContainerSlot)) {
      throw new Error('not a native block slot');
    }

    original.setItem(new ItemStack('minecraft:stone', 4));
    observed.blockBeforeRemoval = inspect(original);
    observed.blockContainerBeforeRemoval = retainedContainer.isValid;
    block.setType('minecraft:air');
    await wait(2);
    observed.blockWhileMissing = inspect(original);
    observed.blockContainerWhileMissing = retainedContainer.isValid;
    let missingRejected = false;

    try {
      nativeAccess.decode(JSON.parse(blockRecipe));
    } catch {
      missingRejected = true;
    }

    observed.missingBlockLookupRejected = missingRejected;
    test.assert(missingRejected, 'A missing inventory cannot be reconstructed');
    block.setType('minecraft:chest');
    await wait(2);
    observed.retainedBlockSlotAfterReplacement = inspect(original);
    observed.retainedBlockContainerAfterReplacement = retainedContainer.isValid;
    const replacement = nativeAccess.decode(JSON.parse(blockRecipe));

    if (!(replacement instanceof ContainerSlot)) {
      throw new Error('not a reconstructed block slot');
    }

    replacement.setItem(new ItemStack('minecraft:diamond', 7));
    observed.freshBlockSlotAfterReplacement = inspect(replacement);
    observed.retainedBlockSlotAfterFreshWrite = inspect(original);
    test.assert(replacement.getItem()?.amount === 7, 'A location lookup resolves the current inventory');
    const forwardedRecipe = nativeAccess.encode(original);
    const reacquired = nativeAccess.decode(JSON.parse(JSON.stringify(forwardedRecipe)));

    observed.forwardedLookupReacquired = reacquired instanceof ContainerSlot && reacquired.getItem()?.amount === 7;
    test.assert(observed.forwardedLookupReacquired === true, 'Captured lookup metadata resolves the current inventory independently of retained handle validity');

    block.setType('minecraft:air');
    dimension.getBlock({ x: point.x, y: point.y - 1, z: point.z })!.setType('minecraft:stone');
    entityId = await provider.create(point.x, point.y, point.z, 'lifetime');
    await provider.write(entityId, 3, 'minecraft:gold_ingot', 2);
    const entityRecipe = await provider.slot(entityId, 3);
    const received = nativeAccess.decode(JSON.parse(entityRecipe));

    if (!(received instanceof ContainerSlot)) {
      throw new Error('not a native entity slot');
    }

    observed.entityBeforeStop = inspect(received);
    await provider.scheduleStop();
    await wait(12);
    test.assert(providerStopped, 'The providing Core runtime stopped');
    observed.providerRegistryEntryAfterStop = core.registry.get('native_access_provider') !== undefined;
    observed.entityAfterProviderStop = inspect(received);
    test.assert(received.isValid && received.getItem()?.amount === 2, 'Minecraft handles outlive the providing Core runtime');
    core.stop();
    const resolvedAfterStop = nativeAccess.decode(JSON.parse(entityRecipe));

    test.assert(resolvedAfterStop instanceof ContainerSlot, 'Native reconstruction does not require Core registration');
    observed.entityAfterConsumerStop = inspect(received);
    test.assert(received.isValid, 'Minecraft handles outlive the consuming Core runtime');
    world.getEntity(entityId)!.remove();
    await wait(2);
    observed.entityAfterRemoval = inspect(received);
    let removedRejected = false;

    try {
      nativeAccess.decode(JSON.parse(entityRecipe));
    } catch {
      removedRejected = true;
    }

    observed.removedEntityLookupRejected = removedRejected;
    test.assert(removedRejected, 'A removed entity cannot be reconstructed');
    console.warn(`NATIVE_ACCESS_LIFETIME ${JSON.stringify(observed)}`);
  } finally {
    if (entityId !== undefined && world.getEntity(entityId)?.isValid) {
      world.getEntity(entityId)!.remove();
    }

    dimension.getBlock(point)?.setPermutation(restore);
    system.afterEvents.scriptEventReceive.unsubscribe(stopped);
    core.stop();
  }
}

register('native_lifetime', 'contracts', (test) => {
  void lifetime(test).then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
}).structureName('native_access:empty').tag('native_lifetime').maxTicks(400);
