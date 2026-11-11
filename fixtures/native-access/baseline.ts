import type { ContainerSlot, Entity } from '@minecraft/server';

export function slot(entity: Entity, index: number): ContainerSlot {
  return entity.getComponent('minecraft:inventory')!.container.getSlot(index);
}
