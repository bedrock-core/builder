export function readSlot(entity, index) {
  return entity.getComponent('minecraft:inventory').container.getSlot(index);
}
