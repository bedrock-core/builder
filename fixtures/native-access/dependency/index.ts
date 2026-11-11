import type { ContainerSlot, Entity } from '@minecraft/server';

export function dependencySlot(entity: Entity, index: number): ContainerSlot {
  const slot = entity.getComponent('minecraft:inventory')?.container.getSlot(index);

  if (!slot) {
    throw new Error('native inventory is unavailable');
  }

  return slot;
}
