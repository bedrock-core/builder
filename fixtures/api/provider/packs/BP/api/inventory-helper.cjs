'use strict';
exports.readSlot = function (entity, index) {
  return entity.getComponent('minecraft:inventory').container.getSlot(index);
};
