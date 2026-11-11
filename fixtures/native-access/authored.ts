import { ItemStack, world as gameWorld } from '@minecraft/server';
import * as minecraft from '@minecraft/server';
import type { Block, ContainerSlot, Entity, EntityInventoryComponent, Vector3 } from '@minecraft/server';
import { librarySlot } from './library';
import { dependencySlot } from '@prototype/native-access-helper';
export { compiledSlot, compiledOptional, compiledBound, compiledDestructured, compiledArgumentOrder, compiledSetContainer, compiledMutations } from '@prototype/native-access-js';
export { compiledCjs, strictReceiver } from '@prototype/native-access-js/commonjs';
export { compiledParenthesized, compiledOptionalParenthesized, compiledDelete } from '@prototype/native-access-js';

const spawnedSlots = new Map<string, ContainerSlot>();
const spawned = gameWorld.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (!entity.isValid) {
    return;
  }

  const slot = entity.getComponent('minecraft:inventory')?.container.getSlot(3);

  if (slot) {
    spawnedSlots.set(entity.id, slot);
  }
});

export function stopEvents(): void {
  gameWorld.afterEvents.entitySpawn.unsubscribe(spawned);
  spawnedSlots.clear();
}

export function nativeCallback(entity: Entity): ContainerSlot | undefined {
  return spawnedSlots.get(entity.id);
}

export function fromDependency(entity: Entity, index: number): ContainerSlot {
  return dependencySlot(entity, index);
}

export function create(location: Vector3, label = 'fixture'): Entity {
  const entity = gameWorld.getDimension('overworld').spawnEntity('minecraft:chest_minecart', location);

  entity.addTag(`native-access:${label}`);

  return entity;
}

export function slot(entity: Entity, index: number): ContainerSlot {
  return entity.getComponent('minecraft:inventory')!.container.getSlot(index);
}

export function blockSlot(block: Block, index: number): ContainerSlot {
  const container = block.getComponent('minecraft:inventory')?.container;

  if (!container) {
    throw new Error('block inventory is unavailable');
  }

  return container.getSlot(index);
}

export function destructured(entity: Entity, index: number): ContainerSlot {
  const { container } = entity.getComponent('minecraft:inventory')!;

  return container.getSlot(index);
}

export function bound(entity: Entity, index: number): ContainerSlot {
  const container = entity.getComponent('minecraft:inventory')!.container;
  const getSlot = container.getSlot.bind(container);

  return getSlot(index);
}

export function borrowed(entity: Entity, index: number): ContainerSlot {
  const container = entity.getComponent('minecraft:inventory')!.container;
  const getSlot = container.getSlot;

  return getSlot.call(container, index);
}

export function fromLibrary(entity: Entity, index: number): ContainerSlot {
  return librarySlot(entity, index);
}

export function namespaceSlot(entityId: string, index: number): ContainerSlot {
  return minecraft.world.getEntity(entityId)!.getComponent('minecraft:inventory')!.container.getSlot(index);
}

export function argumentOrder(entity: Entity, counter: {
  value: number;
}): ContainerSlot {
  return entity.getComponent('minecraft:inventory')!.container.getSlot(counter.value++);
}

export function escaped(entity: Entity, index: number): ContainerSlot {
  const container: {
    getSlot(index: number): ContainerSlot;
  } = entity.getComponent('minecraft:inventory')!.container;

  return container.getSlot(index);
}

export function structural(container: { getSlot(index: number): ContainerSlot }, index: number): ContainerSlot {
  return container.getSlot(index);
}

export function erasedParameter(entity: Entity, index: number): ContainerSlot {
  return structural(entity.getComponent('minecraft:inventory')!.container, index);
}

export function structuralArgument(container: { getSlot(index: number): ContainerSlot }, counter: { value: number }): ContainerSlot {
  return container.getSlot(counter.value++);
}

export function erasedBound(entity: Entity, index: number): ContainerSlot {
  const container = entity.getComponent('minecraft:inventory')!.container;
  const getSlot: (index: number) => ContainerSlot = container.getSlot.bind(container);

  return getSlot(index);
}

export function rebound(entity: Entity, index: number): ContainerSlot {
  const container = entity.getComponent('minecraft:inventory')!.container;
  const getSlot = container.getSlot.bind(container);
  const again: (index: number) => ContainerSlot = getSlot.bind(undefined);

  return again(index);
}

export function optional(entity: Entity | undefined, counter: { value: number }): ContainerSlot | undefined {
  return entity?.getComponent('minecraft:inventory')?.container.getSlot(counter.value++);
}

export function optionalBound(entity: Entity | undefined, index: number): ContainerSlot | undefined {
  const container = entity?.getComponent('minecraft:inventory')?.container;
  const getSlot = container?.getSlot.bind(container);

  return getSlot?.(index);
}

export function optionalMethod(entity: Entity | undefined, index: number): ContainerSlot | undefined {
  return entity?.getComponent('minecraft:inventory')?.container.getSlot?.(index);
}

export function parenthesized(entity: Entity | undefined): unknown {
  return (entity?.getComponent('minecraft:inventory') as EntityInventoryComponent).container;
}

export function parenthesizedMethod(entity: Entity, index: number): ContainerSlot {
  const container = entity.getComponent('minecraft:inventory')!.container;

  return (container.getSlot!)(index);
}

export function parenthesizedOptional(entity: Entity | undefined, counter: { value: number }): ContainerSlot | undefined {
  return (entity?.getComponent('minecraft:inventory')?.container.getSlot)?.(counter.value++);
}

export function parenthesizedRequired(entity: Entity | undefined, counter: { value: number }): ContainerSlot {
  return (entity?.getComponent('minecraft:inventory')?.container.getSlot as (index: number) => ContainerSlot)(counter.value++);
}

export function ordinaryOptional(receiver: { read?(): string } | undefined): string | undefined {
  return receiver?.read?.();
}

export function callback(entity: Entity, index: number): ContainerSlot {
  return [entity].map(value => slot(value, index))[0];
}

export function write(entity: Entity, index: number, typeId: string, amount: number): void {
  slot(entity, index).setItem(new ItemStack(typeId, amount));
}

export function snapshot(entity: Entity, index: number): {
  typeId?: string;
  amount?: number;
} {
  const item = slot(entity, index).getItem();

  if (!item) {
    return {};
  }

  return { typeId: item.typeId, amount: item.amount };
}

export function rawSnapshot(entity: Entity, index: number): ItemStack | undefined {
  return slot(entity, index).getItem();
}

export function remove(entity: Entity): void {
  spawnedSlots.delete(entity.id);
  entity.remove();
}
