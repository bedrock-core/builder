import type { Block, BlockInventoryComponent, BlockPermutation, Container, ContainerSlot, Entity, EntityInventoryComponent, ItemStack } from '@minecraft/server';
import { readSlot } from './inventory-helper.js';
import { readSlot as readCjsSlot } from './inventory-helper.cjs';

export const native = {
  async slot(entity: Entity, index: number): Promise<ContainerSlot> {
    return entity.getComponent('minecraft:inventory')!.container!.getSlot(index);
  },
  async jsSlot(entity: Entity, index: number): Promise<ContainerSlot> {
    return readSlot(entity, index);
  },
  async cjsSlot(entity: Entity, index: number): Promise<ContainerSlot> {
    return readCjsSlot(entity, index);
  },
  async inventory(entity: Entity): Promise<Container | undefined> {
    return entity.getComponent('minecraft:inventory')?.container;
  },
  async component(entity: Entity): Promise<EntityInventoryComponent | undefined> {
    return entity.getComponent('minecraft:inventory');
  },
  async blockComponent(block: Block): Promise<BlockInventoryComponent | undefined> {
    return block.getComponent('minecraft:inventory');
  },
  async blockSlot(block: Block, index: number): Promise<ContainerSlot> {
    return block.getComponent('minecraft:inventory')!.container!.getSlot(index);
  },
  async forward(slot: ContainerSlot): Promise<ContainerSlot> {
    return slot;
  },
  async item(item: ItemStack): Promise<ItemStack> {
    return item.clone();
  },
  async permutation(value: BlockPermutation): Promise<BlockPermutation> {
    return value;
  },
};
