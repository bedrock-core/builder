import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { compileFixture, compileNativeFixture, evaluate, fakeEngine, fixture, runtimeAliases } from '../fixtures/native-access/harness.ts';
import { projectFor } from '../test-support/project.js';

const compiled = await (process.env.BUILDER_NATIVE_ACCESS_COMPILER === 'legacy' ? compileFixture() : compileNativeFixture());
const runtime = await build({ entryPoints: [path.join(fixture, 'runtime.ts')], alias: runtimeAliases, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['@minecraft/server'] });

function pair(options) {
  const engine = fakeEngine(options);
  const sender = engine.realm();
  const receiver = engine.realm();
  const authored = evaluate(compiled.code, sender.minecraft);
  const decoded = evaluate(runtime.outputFiles[0].text, receiver.minecraft).nativeAccess;

  return { engine, sender, receiver, authored, decoded };
}

test('copied native fixtures preserve SDK provenance and resolve the installed public tracker', async (t) => {
  const { project } = await projectFor(t);
  const directory = path.join(project, 'native-fixture');

  await cp(fixture, directory, { recursive: true });
  const copied = await compileNativeFixture(directory);
  const engine = fakeEngine();
  const sender = engine.realm();
  const receiver = engine.realm();
  const authored = evaluate(copied.code, sender.minecraft);
  const decoded = evaluate(runtime.outputFiles[0].text, receiver.minecraft).nativeAccess;
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(authored.slot(entity, 2))));

  assert.ok(copied.instrumented.get(path.join(directory, 'authored.ts')).operations['Entity.getComponent'] > 0);
  assert.equal(recipe.root.kind, 'entity');
  assert.equal(recipe.path.at(-1).args[0], 2);
  assert.ok(decoded.decode(recipe) instanceof receiver.minecraft.ContainerSlot);
});

test('type-directed instrumentation covers imported aliases and bundled library calls', () => {
  const operations = ['authored.ts', 'library.ts', 'dependency/index.ts'].map(file => compiled.instrumented.get(path.join(fixture, file)).operations);

  assert.ok(operations[0]['Entity.getComponent'] > 0);
  assert.ok(operations[0]['Container.getSlot'] > 0);
  assert.ok(operations[1]['Container.getSlot'] > 0);
  assert.ok(operations[2]['Container.getSlot'] > 0);
  assert.doesNotMatch(compiled.code, /new Proxy\(/);
});

test('transformed native calls preserve receivers, returned object identity and lookup provenance', () => {
  const { engine, sender, authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });

  for (const method of ['slot', 'destructured', 'bound', 'borrowed', 'fromLibrary', 'callback']) {
    const value = authored[method](entity, 3);

    assert.equal(value, sender.lastSlot, method);
    assert.ok(value instanceof sender.minecraft.ContainerSlot);
  }

  assert.equal(engine.spawnCount, 1);
});

test('independent realms reconstruct live slots without replaying entity creation', () => {
  const { engine, receiver, authored, decoded } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });

  for (const method of ['slot', 'destructured', 'bound', 'borrowed', 'fromLibrary', 'callback']) {
    const original = authored[method](entity, 3);
    const recipe = JSON.parse(JSON.stringify(authored.access.encode(original)));

    assert.equal(recipe.root.kind, 'entity');
    assert.deepEqual(recipe.path.map(step => step.operation), ['Entity.getComponent', 'EntityInventoryComponent.container', 'Container.getSlot']);
    const received = decoded.decode(recipe);

    assert.ok(received instanceof receiver.minecraft.ContainerSlot);
    received.setItem(new receiver.minecraft.ItemStack('minecraft:diamond', 7));
    assert.equal(original.getItem().typeId, 'minecraft:diamond');
    assert.equal(original.getItem().amount, 7);
    assert.equal(JSON.stringify(decoded.encode(received)), JSON.stringify(recipe));
  }

  assert.equal(engine.spawnCount, 1);
});

test('snapshots remain data and non-lookup operations cannot enter recipes', () => {
  const { authored, decoded } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });

  authored.write(entity, 2, 'minecraft:stone', 4);
  const snapshot = authored.snapshot(entity, 2);

  assert.throws(() => authored.access.encode(authored.rawSnapshot(entity, 2)), /non-replayable.*getItem/);
  authored.write(entity, 2, 'minecraft:dirt', 9);
  assert.equal(snapshot.typeId, 'minecraft:stone');
  assert.equal(snapshot.amount, 4);
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(authored.slot(entity, 2))));

  recipe.path.push({ operation: 'Entity.remove', args: [] });
  assert.throws(() => decoded.decode(recipe), /non-lookup/);
  assert.equal(entity.isValid, true);
});

test('removed owners and invalid indexes reject reconstruction', () => {
  const { authored, decoded } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(authored.slot(entity, 2))));
  const invalid = structuredClone(recipe);

  invalid.path.at(-1).args[0] = -1;
  assert.throws(() => decoded.decode(invalid), /arguments/);
  authored.remove(entity);
  assert.throws(() => decoded.decode(recipe), /owner is unavailable/);
});

test('namespace imports and argument evaluation preserve the captured lookup', () => {
  const { authored, decoded, receiver } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const counter = { value: 3 };
  const selected = authored.argumentOrder(entity, counter);

  assert.equal(counter.value, 4);
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(selected)));

  assert.equal(recipe.path.at(-1).args[0], 3);
  const namespaceRecipe = JSON.parse(JSON.stringify(authored.access.encode(authored.namespaceSlot(entity.id, 3))));

  assert.deepEqual(namespaceRecipe, recipe);
  counter.value = 8;
  assert.ok(decoded.decode(recipe) instanceof receiver.minecraft.ContainerSlot);
});

test('structural aliases and parameters retain native provenance without tracking arbitrary lookalikes', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });

  for (const method of ['escaped', 'erasedParameter', 'erasedBound', 'rebound']) {
    assert.equal(authored.access.encode(authored[method](entity, 2)).path.at(-1).operation, 'Container.getSlot');
  }

  const lookalike = { getSlot: index => entity.getComponent('minecraft:inventory').container.getSlot(index) };

  assert.throws(() => authored.access.encode(authored.structural(lookalike, 2)), /no captured lookup path/);
});

test('optional chains preserve short-circuiting, argument evaluation, binding and parenthesis boundaries', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const counter = { value: 2 };

  assert.equal(authored.optional(undefined, counter), undefined);
  assert.equal(counter.value, 2);
  assert.equal(authored.optional({ getComponent: () => undefined }, counter), undefined);
  assert.equal(counter.value, 2);
  assert.equal(authored.access.encode(authored.optional(entity, counter)).path.at(-1).args[0], 2);
  assert.equal(counter.value, 3);

  for (const method of ['optionalBound', 'optionalMethod']) {
    assert.equal(authored[method](undefined, 2), undefined);
    assert.equal(authored.access.encode(authored[method](entity, 2)).path.at(-1).args[0], 2);
  }

  assert.throws(() => authored.parenthesized(undefined));

  assert.equal(authored.access.encode(authored.parenthesizedMethod(entity, 4)).path.at(-1).args[0], 4);
  assert.equal(authored.parenthesizedOptional(undefined, counter), undefined);
  assert.equal(counter.value, 3);
  assert.equal(authored.access.encode(authored.parenthesizedOptional(entity, counter)).path.at(-1).args[0], 3);
  assert.equal(counter.value, 4);
  assert.throws(() => authored.parenthesizedRequired(undefined, counter));
  assert.equal(counter.value, 5);
  assert.equal(authored.access.encode(authored.parenthesizedRequired(entity, counter)).path.at(-1).args[0], 5);
});

test('identity lookups and data reads retain direct native code', () => {
  const operations = compiled.instrumented.get(path.join(fixture, 'authored.ts')).operations;

  assert.equal(operations['World.getEntity'], undefined);
  assert.equal(operations['World.getDimension'], undefined);
  assert.equal(operations['Dimension.spawnEntity'], undefined);
  assert.equal(operations['ItemStack.typeId'], undefined);
});

test('ordinary optional calls keep JavaScript call semantics', () => {
  const { authored } = pair();
  const receiver = { read() {
    return this === receiver ? 'correct' : 'wrong receiver';
  } };

  receiver.read.call = () => 'wrong call';
  assert.equal(authored.ordinaryOptional(undefined), undefined);
  assert.equal(authored.ordinaryOptional({}), undefined);
  assert.equal(authored.ordinaryOptional(receiver), 'correct');
});

test('erased receivers preserve method reads before arguments and keep the authored receiver', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const order = [];
  const counter = { get value() {
    order.push('argument');

    return 3;
  }, set value(_next) { order.push('increment'); } };
  const receiver = { get getSlot() {
    order.push('method');

    return function (index) {
      assert.equal(this, receiver);

      return authored.slot(entity, index);
    };
  } };
  const slot = authored.structuralArgument(receiver, counter);

  assert.deepEqual(order, ['method', 'argument', 'increment']);
  assert.equal(authored.access.encode(slot).path.at(-1).args[0], 3);
});

test('encoded recipes do not share mutable path data with retained origins', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const slot = authored.slot(entity, 3);
  const first = authored.access.encode(slot);

  first.path[0].args[0] = 'changed';
  first.root.id = 'changed';
  const second = authored.access.encode(slot);

  assert.equal(second.root.id, entity.id);
  assert.equal(second.path[0].args[0], 'minecraft:inventory');
});

test('native event callbacks preserve subscription identity and capture native payload lookups', () => {
  const { authored, decoded, sender, receiver } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const selected = authored.nativeCallback(entity);
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(selected)));

  assert.equal(sender.spawnSubscriptions, 1);
  assert.ok(decoded.decode(recipe) instanceof receiver.minecraft.ContainerSlot);
  assert.equal(recipe.path.at(-1).args[0], 3);
  authored.stopEvents();
  assert.equal(sender.spawnSubscriptions, 0);
});

test('installed dependency lookups keep their native receiver and reconstruction path', () => {
  const { authored, decoded, receiver } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(authored.fromDependency(entity, 4))));

  assert.equal(recipe.path.at(-1).args[0], 4);
  assert.ok(decoded.decode(recipe) instanceof receiver.minecraft.ContainerSlot);
});

test('local inventory handles require provenance while declared owner inputs remain usable', () => {
  const { authored, decoded, receiver } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const component = entity.getComponent('minecraft:inventory');
  const local = component.container;

  assert.equal(component.entity, entity);
  assert.equal(component.typeId, 'minecraft:inventory');
  assert.throws(() => authored.access.encode(local), /no captured lookup path/);
  assert.throws(() => authored.access.encode(local.getSlot(3)), /no captured lookup path/);
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(authored.slot(entity, 3))));

  assert.ok(decoded.decode(recipe) instanceof receiver.minecraft.ContainerSlot);
});

for (const blockInventoryLifetime of ['replaced', 'location']) {
  test(`block inventory lookup preserves engine-owned ${blockInventoryLifetime} slot lifetime`, () => {
    const { engine, sender, receiver, authored, decoded } = pair({ blockInventoryLifetime });
    const location = { x: 4, y: 64, z: -2 };
    const block = sender.minecraft.world.getDimension('overworld').getBlock(location);

    block.setType('minecraft:chest');
    const original = authored.blockSlot(block, 3);
    const recipe = JSON.parse(JSON.stringify(authored.access.encode(original)));
    const retained = decoded.decode(recipe);

    assert.deepEqual(recipe.root, { kind: 'block', dimension: block.dimension.id, ...location });
    assert.deepEqual(recipe.path.map(step => step.operation), ['Block.getComponent', 'BlockInventoryComponent.container', 'Container.getSlot']);
    retained.setItem(new receiver.minecraft.ItemStack('minecraft:stone', 4));
    assert.equal(original.getItem().amount, 4);
    block.setType('minecraft:air');
    assert.equal(original.isValid, false);
    assert.equal(retained.isValid, false);
    assert.throws(() => decoded.decode(recipe), /lookup is unavailable/);
    block.setType('minecraft:chest');
    const current = decoded.decode(recipe);

    assert.ok(current instanceof receiver.minecraft.ContainerSlot);
    assert.equal(current.getItem(), undefined);
    current.setItem(new receiver.minecraft.ItemStack('minecraft:diamond', 7));
    const forwarded = JSON.parse(JSON.stringify(authored.access.encode(original)));
    const reacquired = decoded.decode(forwarded);

    assert.deepEqual(forwarded, recipe);
    assert.equal(reacquired.getItem().typeId, 'minecraft:diamond');
    assert.equal(reacquired.getItem().amount, 7);
    assert.equal(original.isValid, blockInventoryLifetime === 'location');
    assert.equal(retained.isValid, blockInventoryLifetime === 'location');

    if (blockInventoryLifetime === 'location') {
      assert.equal(retained.getItem().amount, 7);
    } else {
      assert.throws(() => original.setItem(new sender.minecraft.ItemStack('minecraft:dirt')), /invalid slot/);
    }

    assert.equal(engine.spawnCount, 0);
  });

  test(`forwarded block containers preserve engine-owned ${blockInventoryLifetime} lifetime in a third realm`, () => {
    const { engine, sender, authored, decoded } = pair({ blockInventoryLifetime });
    const block = sender.minecraft.world.getDimension('overworld').getBlock({ x: 1, y: 64, z: 2 });

    block.setType('minecraft:chest');
    const recipe = JSON.parse(JSON.stringify(authored.access.encode(authored.blockSlot(block, 2))));

    recipe.path.pop();
    const container = decoded.decode(recipe);

    block.setType('minecraft:air');
    assert.equal(container.isValid, false);
    block.setType('minecraft:chest');
    const third = engine.realm();
    const access = evaluate(runtime.outputFiles[0].text, third.minecraft).nativeAccess;
    const current = access.decode(JSON.parse(JSON.stringify(decoded.encode(container))));

    current.getSlot(2).setItem(new third.minecraft.ItemStack('minecraft:gold_ingot', 5));
    assert.equal(authored.blockSlot(block, 2).getItem().amount, 5);
    assert.equal(container.isValid, blockInventoryLifetime === 'location');
  });
}

test('JavaScript modules with separate declarations reconstruct native slots across realms', () => {
  const { engine, authored, decoded, receiver } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });

  for (const method of ['compiledSlot', 'compiledOptional', 'compiledBound', 'compiledDestructured', 'compiledCjs']) {
    const original = authored[method](entity, 4);
    const recipe = JSON.parse(JSON.stringify(authored.access.encode(original)));
    const received = decoded.decode(recipe);

    assert.ok(received instanceof receiver.minecraft.ContainerSlot, method);
    assert.deepEqual(recipe.path.map(step => step.operation), ['Entity.getComponent', 'EntityInventoryComponent.container', 'Container.getSlot']);
    received.setItem(new receiver.minecraft.ItemStack('minecraft:diamond', 7));
    assert.equal(original.getItem().amount, 7, method);
  }

  assert.equal(engine.spawnCount, 1);
  assert.equal(authored.compiledOptional(undefined, 4), undefined);
  const read = authored.strictReceiver;

  assert.equal(read(), undefined);
  const cjs = compiled.instrumented.get(path.join(fixture, 'javascript-dependency/commonjs.cjs')).code;

  assert.match(cjs, /^['"]use strict['"];\s*const /);
  assert.match(cjs, /require\(/);
  assert.doesNotMatch(cjs, /^import /m);
  assert.ok(compiled.instrumented.get(path.join(fixture, 'javascript-dependency/internal.js')).operations['lookup:getSlot'] > 0);
});

test('erased JavaScript lookalikes retain receiver and evaluation order without acquiring native provenance', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const order = [];
  const container = { get getSlot() {
    order.push('method');

    return function (index) {
      assert.equal(this, container);
      order.push('call');

      return entity.getComponent('minecraft:inventory').container.getSlot(index);
    };
  } };
  const owner = { getComponent() {
    assert.equal(this, owner);
    order.push('component');

    return { get container() {
      order.push('container');

      return container;
    } };
  } };
  const counter = { get value() {
    order.push('argument');

    return 3;
  }, set value(_value) { order.push('increment'); } };
  const received = authored.compiledArgumentOrder(owner, counter);

  assert.deepEqual(order, ['component', 'container', 'method', 'argument', 'increment', 'call']);
  assert.throws(() => authored.access.encode(received), /no captured lookup path/);
  const ordinary = { container: 1 };

  assert.equal(authored.compiledSetContainer(ordinary, 2), 2);
  assert.equal(ordinary.container, 2);
  const result = authored.compiledMutations(ordinary);

  assert.equal(result.previous, 2);
  assert.equal(result.removed, true);
  assert.equal(Object.hasOwn(ordinary, 'container'), false);
  const component = { container: 1 };

  assert.equal(authored.compiledDelete({ getComponent: () => component }), true);
  assert.equal(Object.hasOwn(component, 'container'), false);
});

test('erased JavaScript parenthesized calls preserve native receivers and optional argument evaluation', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const counter = { value: 2 };

  assert.equal(authored.access.encode(authored.compiledParenthesized(entity, 3)).path.at(-1).args[0], 3);
  assert.throws(() => authored.compiledParenthesized(undefined, 3));
  assert.equal(authored.compiledOptionalParenthesized(undefined, counter), undefined);
  assert.equal(counter.value, 2);
  assert.equal(authored.access.encode(authored.compiledOptionalParenthesized(entity, counter)).path.at(-1).args[0], 2);
  assert.equal(counter.value, 3);
});

test('contiguous inventory lookup preserves earlier getter failures without evaluating the slot argument', () => {
  const { authored } = pair();
  const counter = { value: 4 };
  const owner = { getComponent() {
    return { get container() {
      throw new Error('inventory unavailable');
    } };
  } };

  assert.throws(() => authored.compiledArgumentOrder(owner, counter), /inventory unavailable/);
  assert.equal(counter.value, 4);
});

test('contiguous erased lookup retains an existing component provenance through an ordinary owner', () => {
  const { authored, decoded, receiver } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const original = JSON.parse(JSON.stringify(authored.access.encode(authored.slot(entity, 3))));

  original.path = original.path.slice(0, 1);
  const component = authored.access.decode(original);
  const owner = { getComponent: () => component };
  const selected = authored.compiledArgumentOrder(owner, { value: 5 });
  const recipe = JSON.parse(JSON.stringify(authored.access.encode(selected)));

  assert.equal(recipe.root.id, entity.id);
  assert.equal(recipe.path.at(-1).args[0], 5);
  assert.ok(decoded.decode(recipe) instanceof receiver.minecraft.ContainerSlot);
});

test('reused inventory recipes retain each captured slot index and copy encoded data', () => {
  const { authored } = pair();
  const entity = authored.create({ x: 0, y: 0, z: 0 });
  const selected = Array.from({ length: 9 }, (_, index) => authored.slot(entity, index));

  for (let index = 0; index < 9; index++) {
    authored.compiledSlot(entity, index);
    authored.compiledCjs(entity, index);
  }

  for (let index = 0; index < selected.length; index++) {
    const first = authored.access.encode(selected[index]);

    assert.equal(first.path.at(-1).args[0], index);
    first.path.at(-1).args[0] = 99;
    assert.equal(authored.access.encode(selected[index]).path.at(-1).args[0], index);
  }
});
