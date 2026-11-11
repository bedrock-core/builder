import { BlockInventoryComponent, BlockPermutation, Container, ContainerSlot, EntityInventoryComponent, ItemLockMode, ItemStack, system } from '@minecraft/server';
import type { Test } from '@minecraft/server-gametest';
import { native } from '@bedrock-core/api-provider';

/** Generated package bindings resolve native objects in the receiving addon. */
export async function nativeContracts(test: Test): Promise<void> {
  const entity = test.spawn('minecraft:chest_minecart', { x: 2, y: 2, z: 2 });
  const block = entity.dimension.getBlock(test.worldLocation({ x: 4, y: 1, z: 4 }))!;
  const restore = block.permutation;
  const settle = (): Promise<void> => new Promise(resolve => system.runTimeout(resolve, 2));

  try {
    const component = await native.component(entity);
    const container = await native.inventory(entity).catch((error: unknown) => {
      throw new Error(`inventory: ${String(error)}`);
    });

    test.assert(component instanceof EntityInventoryComponent && component.entity.id === entity.id, 'Component owner and SDK class survive transport');
    test.assert(container instanceof Container, 'The receiving addon obtains a native container');

    for (const [index, read] of [native.slot, native.jsSlot, native.cjsSlot].entries()) {
      const slot = await read(entity, index).catch((error: unknown) => {
        throw new Error(`slot variant ${index}: ${String(error)}`);
      });

      test.assert(slot instanceof ContainerSlot, 'TypeScript, ESM and CommonJS return native slots');
      const sword = new ItemStack('minecraft:diamond_sword');

      sword.nameTag = 'Native slot data';
      sword.setLore(['Exact native item']);
      slot.setItem(sword);
      test.assert(container!.getSlot(index).getItem()?.nameTag === sword.nameTag, 'Native writes reach the owner inventory');
      const forwarded = await native.forward(slot).catch((error: unknown) => {
        throw new Error(`forwarded slot ${index}: ${String(error)}`);
      });

      test.assert(forwarded instanceof ContainerSlot && forwarded.getItem()?.getLore()[0] === 'Exact native item', 'Forwarding preserves the lookup without serializing item data');
    }

    const item = new ItemStack('minecraft:stone', 7);
    const copied = await native.item(item);

    test.assert(copied instanceof ItemStack && copied !== item && copied.amount === item.amount && copied.isStackableWith(item), 'ItemStack snapshots preserve native stacking data and amount');
    copied.amount = 2;
    test.assert(item.amount === 7, 'ItemStack snapshots are independent receiving values');
    let rejected = false;

    try {
      await native.item(new ItemStack('minecraft:diamond_sword'));
    } catch (error) {
      rejected = String(error).includes('fidelity');
    }

    test.assert(rejected, 'Items without a fidelity check reject instead of losing data');
    const decorated = new ItemStack('minecraft:stone', 3);

    decorated.nameTag = 'Copied metadata';
    decorated.keepOnDeath = true;
    decorated.lockMode = ItemLockMode.slot;
    decorated.setLore([{ text: 'Exact lore' }, { translate: 'item.apple.name' }]);
    decorated.setCanDestroy(['minecraft:dirt']);
    decorated.setCanPlaceOn(['minecraft:stone']);
    const equivalent = decorated.isStackableWith(decorated.clone());

    if (equivalent) {
      const snapshot = await native.item(decorated);

      test.assert(snapshot.isStackableWith(decorated) && snapshot.amount === 3
        && JSON.stringify(snapshot.getRawLore()) === JSON.stringify(decorated.getRawLore()), 'Supported custom item metadata and raw lore survive a cross-addon copy');
    } else {
      let refused = false;

      try {
        await native.item(decorated);
      } catch {
        refused = true;
      }

      test.assert(refused, 'Non-stackable custom metadata rejects rather than losing data');
    }

    const permutation = BlockPermutation.resolve('minecraft:oak_log', { pillar_axis: 'x' });
    const received = await native.permutation(permutation);

    test.assert(received instanceof BlockPermutation && received.type.id === permutation.type.id
      && JSON.stringify(received.getAllStates()) === JSON.stringify(permutation.getAllStates()), 'BlockPermutation preserves every native block state');
    block.setType('minecraft:chest');
    await settle();
    const blockComponent = await native.blockComponent(block);

    test.assert(blockComponent instanceof BlockInventoryComponent && blockComponent.block.location.x === block.location.x, 'Block components preserve their native owner location');
    const retained = await native.blockSlot(block, 3);

    retained.setItem(new ItemStack('minecraft:stone', 2));
    block.setType('minecraft:air');
    await settle();
    let unavailable = false;

    try {
      await native.forward(retained);
    } catch (error) {
      unavailable = String(error).includes('unavailable');
    }

    test.assert(unavailable, 'A missing block inventory rejects required reference resolution');
    block.setType('minecraft:chest');
    await settle();
    const replacement = await native.forward(retained);

    replacement.setItem(new ItemStack('minecraft:diamond', 7));
    test.assert(block.getComponent('minecraft:inventory')!.container!.getSlot(3).getItem()?.amount === 7, 'Forwarded block lookups resolve the current inventory after replacement');
  } finally {
    block.setPermutation(restore);

    if (entity.isValid) {
      entity.remove();
    }
  }
}
