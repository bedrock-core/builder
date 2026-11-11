export function inventorySlot(entity, index) {
  return entity.getComponent('minecraft:inventory').container.getSlot(index);
}
