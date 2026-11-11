'use strict';

exports.compiledCjs = function (entity, index) {
  return entity.getComponent('minecraft:inventory').container.getSlot(index);
};

exports.strictReceiver = function () {
  return this;
};
