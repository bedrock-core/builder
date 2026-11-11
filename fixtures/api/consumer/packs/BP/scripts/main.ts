import { core } from '@bedrock-core/server-runtime';
import { Block, Dimension, Entity, Player, system } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import * as provider from '@bedrock-core/api-provider';
import { changeCurrency, changed, currency, fail, optionalArgument, ownerNamespace } from '@bedrock-core/api-provider';
import { math } from '@bedrock-core/api-provider/math';
import { Money } from '@bedrock-core/api-provider';
import { Money as SharedMoney } from '@bedrock-core/api-provider/values';
import { world } from '@bedrock-core/api-provider';
import { accounts } from '@bedrock-core/api-provider';
import providerManifest from '@bedrock-core/api-provider/manifest.json';
import { ping } from '@bedrock-core/api-optional';
import manifest from '../manifest.json';
import { nativeContracts } from './native-contracts';

core.register({ manifest });

const wait = (ticks: number): Promise<void> => new Promise(resolve => system.runTimeout(resolve, ticks));

async function roundtrip(test: Test): Promise<void> {
  test.assert(await ownerNamespace() === 'core_peer_api_provider', 'Calls execute in the provider realm');
  test.assert(await provider.ownerNamespace() === 'core_peer_api_provider', 'Namespace imports share the provider route');
  test.assert(await math.multiply(6, 7) === 42, 'Subpath and nested methods preserve argument tuples');
  test.assert(provider.info.nested.enabled && provider.info.revision === 1, 'Static constants retain their values');
  test.assert(Object.keys(provider.info).join(',') === 'name,revision,nested', 'Static objects retain authored property order');
  test.assert(Object.isFrozen(provider.info) && Object.isFrozen(provider.info.nested), 'Static constants are deeply immutable');
  test.assert(providerManifest.namespace === 'core_peer_api_provider' && Object.isFrozen(providerManifest.header), 'Manifest exports are immutable authored metadata');

  const optional = await optionalArgument(undefined, 'second');

  test.assert(optional.first === 'default' && optional.second === 'second', 'Undefined argument positions preserve default parameters');
  const omitted = await optionalArgument(undefined);

  test.assert(omitted.first === 'default' && Object.hasOwn(omitted, 'second') && omitted.second === undefined, 'Results preserve defaults and explicitly undefined own properties');

  let failure = '';

  try {
    await fail('provider-error');
  } catch (error) {
    failure = String(error);
  }

  test.assert(failure.includes('provider-error'), 'Provider errors reach the caller');

  let snapshots = 0;
  const announcements: string[] = [];
  const stopState = currency.subscribe((value) => {
    if (value === 'gold') {
      snapshots++;
    }
  });
  const stopEvents = changed.subscribe((value) => {
    announcements.push(value.currency);
  });

  try {
    test.assert(await changeCurrency('gold') === 'gold', 'Public functions retain owner writes');
    await wait(12);
    test.assert(currency.get() === 'gold', 'State handles read synchronized local snapshots');
    test.assert(snapshots > 0, 'State subscribers receive updates');
    test.assert(announcements.includes('gold'), 'Signals deliver transient payloads');
    test.assert(!('set' in currency) && !('emit' in changed), 'API handles are read only');
    let replayed = 0;
    const stopLate = changed.subscribe(() => {
      replayed++;
    });

    await wait(1);
    stopLate();
    test.assert(replayed === 0, 'Signal subscriptions do not replay prior events');
  } finally {
    stopState();
    stopState();
    stopEvents();
    stopEvents();
  }

  const count = announcements.length;

  await changeCurrency('diamond');
  await wait(12);
  test.assert(announcements.length === count, 'Unsubscribed listeners receive no further events');
  test.assert(currency.get() === 'diamond', 'Unobserved state remains current');
}

async function absentOptional(test: Test): Promise<void> {
  let failure = '';

  try {
    await ping();
  } catch (error) {
    failure = String(error);
  }

  test.assert(failure.includes('core_peer_api_optional'), 'An absent optional addon rejects with target identity');
}

async function classesAndCallbacks(test: Test): Promise<void> {
  test.assert(Money === SharedMoney, 'Root and shared imports use the same constructor');
  const request = { price: new Money(5), extras: [new Money(2)], pair: [new Money(3), 'quote'] as [Money, string], byId: { bonus: new Money(1) } };
  let decisions = 0;
  const snapshots: string[] = [];
  const events: string[] = [];
  const stopState = provider.funds.subscribe(value => snapshots.push(value?.format() ?? 'missing'));
  const stopEvent = provider.quoted.subscribe(value => events.push(value.price.format()));

  try {
    const result = await provider.purchase(request, async (price, note = 'default', ...extras): Promise<Money> => {
      test.assert(core.namespace === 'core_peer_api_consumer', 'The callback runs in its caller realm');
      test.assert(price instanceof Money && price.format() === '9 gold', 'Callback arguments reconstruct value classes');
      test.assert(note === 'default', 'Callback defaults preserve undefined argument positions');
      decisions++;

      return new Money(price.gold + extras.reduce((sum, extra) => sum + extra.gold, 0));
    });

    test.assert(result instanceof Money && result.format() === '11 gold', 'The API result reconstructs a value class');
    await wait(12);
    test.assert(provider.funds.get()?.format() === '11 gold', 'State reconstructs its value class');
    test.assert(provider.funds.get() === provider.funds.get(), 'Decoded snapshots retain their identity');
    test.assert(snapshots.includes('11 gold') && events.includes('11 gold'), 'State and signals deliver value classes');
    test.assert(decisions === 1 && await provider.confirmationReleased(), 'A completed call releases its callback');

    let failure = '';

    try {
      await provider.purchase(request, async (): Promise<Money> => {
        throw new Error('confirmation-failed');
      });
    } catch (error) {
      failure = String(error);
    }

    test.assert(failure.includes('confirmation-failed') && await provider.confirmationReleased(), 'Rejected calls release their callbacks');
  } finally {
    stopState();
    stopEvent();
  }
}

async function worldApi(test: Test): Promise<void> {
  const entity = test.spawnWithoutBehaviors('minecraft:pig', { x: 1, y: 2, z: 1 });
  const player = test.spawnSimulatedPlayer({ x: 2, y: 2, z: 2 }, 'ApiReferenceFixture');
  const entityId = entity.id;
  const events: { id: string; live: boolean; price: string }[] = [];
  const snapshots: string[] = [];
  let confirmations = 0;
  const oldTime = await world.getTime();
  const stopState = world.tracked.subscribe(value => snapshots.push(value?.price.format() ?? 'missing'));
  const stopEvent = world.afterEvents.entityDropItem.subscribe((event) => {
    test.assert(Object.isFrozen(event) && Object.isFrozen(event.price), 'Event data is immutable');

    if (event.entity !== undefined) {
      test.assert(event.entity instanceof Entity && !Object.isFrozen(event.entity), 'Event entities remain native, mutable handles');
      event.entity.addTag('api:observed');
    }

    events.push({ id: event.entityId, live: event.entity?.isValid === true, price: event.price.format() });
  });

  try {
    test.assert(Object.isFrozen(world) && Object.isFrozen(world.afterEvents), 'Nested API objects are immutable');
    await world.setTimeOfDay(1234);
    await wait(8);
    test.assert(world.timeOfDay.get() === 1234, 'Nested API state uses ordinary observables');
    await world.track(entity);
    test.assert(entity.hasTag('api:tracked'), 'The provider receives a live entity argument');
    const found = await world.getEntity(entityId);

    test.assert(found instanceof Entity && found.id === entityId, 'Entity results resolve locally');
    const result = await world.quote(entity, new Money(7), async (reference, price): Promise<Money> => {
      test.assert(core.namespace === 'core_peer_api_consumer', 'Nested callbacks run in the caller addon');
      test.assert(reference instanceof Entity && reference.id === entityId && reference.isValid, 'Callbacks receive native entity references');
      test.assert(price instanceof Money && price.format() === '7 gold', 'Callbacks reconstruct custom class arguments');
      reference.addTag('api:approved');
      confirmations++;

      return new Money(price.gold + 2);
    });

    test.assert(result.entity instanceof Entity && result.entity.id === entityId && result.price instanceof Money, 'Results combine live references with custom classes');
    test.assert(result.price.format() === '9 gold' && confirmations === 1 && entity.hasTag('api:approved'), 'The callback result reaches the provider');
    await wait(8);
    const snapshot = world.tracked.get();

    test.assert(snapshot?.entity instanceof Entity && snapshot.entity.id === entityId && snapshot.price instanceof Money, 'Snapshots combine live references and class instances');
    test.assert(Object.isFrozen(snapshot) && !Object.isFrozen(snapshot?.entity), 'Snapshot containers freeze without freezing engine handles');
    test.assert(snapshot === world.tracked.get(), 'Decoded snapshots retain their identity');
    test.assert(snapshots.includes('9 gold') && events.some(event => event.id === entityId && event.live && event.price === '9 gold'), 'Nested state and events deliver typed payloads');
    test.assert(entity.hasTag('api:observed'), 'Event handlers can use native entity methods');

    const foundPlayer = await world.getPlayer(player.id);

    test.assert(foundPlayer instanceof Player && foundPlayer.id === player.id, 'Player results resolve as native Player handles');
    test.assert(await world.getPlayerId(player) === player.id, 'Player arguments use the dedicated reference contract');
    test.assert(await world.getPlayer(entityId) === undefined, 'Player lookups can return no matching player');

    await world.remove(entity);
    await wait(8);
    test.assert(await world.getEntity(entityId) === undefined, 'Removed entities resolve as unavailable');
    test.assert(world.tracked.get()?.entity === undefined, 'Optional snapshot references tolerate removal');
    test.assert(events.some(event => event.id === entityId && !event.live && event.price === '0 gold'), 'An event retains its identity and class data after entity removal');
    let failure = '';

    try {
      await world.track(entity);
    } catch (error) {
      failure = String(error);
    }

    test.assert(failure.includes('unavailable'), 'Required references reject when their entity has disappeared');
    stopEvent();
    stopEvent();
    const count = events.length;

    await world.quote(player, new Money(1), async (_entity, price): Promise<Money> => price);
    await wait(8);
    test.assert(events.length === count, 'Nested event subscriptions release idempotently');
  } finally {
    stopState();
    stopEvent();
    await world.setTimeOfDay(oldTime);

    if (entity.isValid) {
      entity.remove();
    }

    if (player.isValid) {
      player.disconnect();
    }
  }
}

async function nativeReferenceAdapters(test: Test): Promise<void> {
  await nativeContracts(test);
  const block = test.getBlock({ x: 3, y: 1, z: 3 });

  try {
    block.setType('minecraft:stone');
    const dimension = await world.getDimension(block.dimension.id);

    test.assert(dimension instanceof Dimension && dimension.id === block.dimension.id, 'Dimensions resolve as native handles');
    const found = await world.getBlock(dimension, block.location);

    test.assert(found instanceof Block && found.typeId === 'minecraft:stone', 'Block results use dimension/location addresses');

    if (found === undefined) {
      throw new Error('fixture block is unavailable');
    }

    found.setType('minecraft:gold_block');
    const result = await world.describeBlock(found);

    test.assert(result.block instanceof Block && result.dimension instanceof Dimension, 'Native references compose in result objects');
    test.assert(result.typeId === 'minecraft:gold_block' && result.block.typeId === 'minecraft:gold_block', 'Block addresses follow the current contents at their location');
  } finally {
    block.setType('minecraft:air');
  }
}

async function accountReferences(test: Test): Promise<void> {
  const account = await accounts.open('fixture');
  const updates: string[] = [];
  const snapshots: string[] = [];
  const stopState = account.balance.subscribe(value => snapshots.push(value?.format() ?? 'missing'));
  const stopEvent = account.changed.subscribe(value => updates.push(value.format()));

  try {
    test.assert(await accounts.open('fixture') === account, 'Repeated object results preserve client identity');
    test.assert(await accounts.identity(account, 'fixture'), 'Passing a reference back resolves its original owner instance');
    test.assert(await account.owner() === 'core_peer_api_provider', 'Object methods execute in their owner addon');
    const result = await account.deposit(new Money(4), async (current, amount): Promise<boolean> => {
      test.assert(core.namespace === 'core_peer_api_consumer', 'Object method callbacks execute in the caller');
      test.assert(current instanceof Money && amount instanceof Money, 'Object callbacks retain custom class values');

      return true;
    });

    test.assert(result instanceof Money && result.format() === '4 gold', 'Object method results retain custom class values');
    await wait(8);
    test.assert(account.balance.get()?.format() === '4 gold' && snapshots.includes('4 gold'), 'Object state uses synchronized observable snapshots');
    test.assert(updates.includes('4 gold'), 'Object signals use existing event delivery');
    let denied = false;

    try {
      core.api.release(account);
    } catch {
      denied = true;
    }

    test.assert(denied, 'Only the owner can release an object instance');
    await account.close();
    await wait(8);
    test.assert(account.balance.get() === undefined && snapshots[snapshots.length - 1] === 'missing', 'Release withdraws object state and subscribers');
    let failure = '';

    try {
      await account.owner();
    } catch (error) {
      failure = String(error);
    }

    test.assert(failure.includes('unavailable') || failure.includes('released'), 'Released handles reject new operations');
    const replacement = await accounts.open('fixture');

    test.assert(replacement !== account, 'A new owner object does not revive a released handle');
    await replacement.close();
  } finally {
    stopState();
    stopState();
    stopEvent();
    stopEvent();
  }
}

async function explicitSubscriptions(test: Test): Promise<void> {
  const events: number[] = [];
  const values: (number | undefined)[] = [];

  const event = (value: number): void => {
    events.push(value);
  };

  const state = (value: number | undefined): void => {
    values.push(value);
  };

  const stopEvent = provider.explicitChanged.subscribe(event);
  const stopState = provider.signalCount.subscribe(state);

  test.assert(!('unsubscribe' in provider.explicitChanged), 'Imported signals expose only cleanup-return subscriptions');
  await provider.emitExplicit(1);
  await wait(12);
  test.assert(events.includes(1) && values.includes(1), 'Explicit provider state and events cross addon boundaries');
  stopEvent();
  stopState();
  await provider.emitExplicit(2);
  await wait(8);
  test.assert(!events.includes(2) && !values.includes(2), 'Explicit consumer removal stops delivery');
  const stop = provider.explicitChanged.subscribe(event);

  await provider.emitExplicit(3);
  await wait(8);
  test.assert(events.includes(3), 'Explicit API signals normalize to a cleanup function');
  stop();
  stop();
  await provider.emitExplicit(4);
  await wait(8);
  test.assert(!events.includes(4), 'Normalized cleanup is idempotent and detaches');
}

for (const [name, run] of [['roundtrip', roundtrip], ['absent_optional', absentOptional], ['classes_and_callbacks', classesAndCallbacks], ['world_api', worldApi], ['native_reference_adapters', nativeReferenceAdapters], ['account_references', accountReferences], ['explicit_subscriptions', explicitSubscriptions]] as const) {
  register('api', name, (test) => {
    void run(test).then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
  }).structureName('api:empty').tag('api').maxTicks(360);
}
