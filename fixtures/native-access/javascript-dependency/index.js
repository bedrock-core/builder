import { inventorySlot } from './internal.js';

export function compiledSlot(entity, index) {
  return inventorySlot(entity, index);
}

export function compiledOptional(entity, index) {
  return entity?.getComponent('minecraft:inventory')?.container.getSlot(index);
}

export function compiledBound(entity, index) {
  const container = entity.getComponent('minecraft:inventory').container;
  const read = container.getSlot.bind(container);

  return read(index);
}

export function compiledDestructured(entity, index) {
  const { container } = entity.getComponent('minecraft:inventory');

  return container.getSlot(index);
}

export function compiledArgumentOrder(entity, counter) {
  return entity.getComponent('minecraft:inventory').container.getSlot(counter.value++);
}

export function compiledSetContainer(owner, value) {
  owner.container = value;

  return owner.container;
}

export function compiledMutations(owner) {
  const previous = owner.container++;
  const removed = delete owner.container;

  return { previous, removed };
}

export function compiledParenthesized(entity, index) {
  // eslint-disable-next-line no-unsafe-optional-chaining -- The required call must throw for an absent receiver.
  return (entity?.getComponent('minecraft:inventory')?.container.getSlot)(index);
}

export function compiledOptionalParenthesized(entity, counter) {
  return (entity?.getComponent('minecraft:inventory')?.container.getSlot)?.(counter.value++);
}

export function compiledDelete(owner) {
  return delete owner.getComponent('minecraft:inventory')?.container;
}
