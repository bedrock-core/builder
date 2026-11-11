import { Block, Entity, system } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import * as provider from '@bedrock-core/api-provider';
import { Money } from '@bedrock-core/api-provider';
import { Money as SharedMoney } from '@bedrock-core/api-provider/values';
import { math } from '@bedrock-core/api-provider/math';
import manifest from '@bedrock-core/api-provider/manifest.json';
import { ping } from '@bedrock-core/api-optional';
import { nativeContracts } from './native-contracts';

const wait = (ticks: number): Promise<void> => new Promise(resolve => system.runTimeout(resolve, ticks));

async function contracts(test: Test): Promise<void> {
  test.assert(await provider.API.ownerNamespace() === 'core_peer_api_provider', 'Registered API objects execute in their owning pack');
  test.assert(provider.API.Money === Money && !('set' in provider.API.currency) && !('emit' in provider.API.changed), 'API objects retain shared classes and read-only consumer handles');
  test.assert(await provider.ownerNamespace() === 'core_peer_api_provider', 'Calls execute in the provider pack');
  test.assert(await math.multiply(6, 7) === 42, 'Package subpaths work without import transforms');
  test.assert(Object.isFrozen(provider.info.nested) && Object.isFrozen(manifest.header), 'Published metadata remains immutable');
  test.assert(Money === SharedMoney, 'Root and shared imports use one value constructor');
  const optional = await provider.optionalArgument(undefined, 'second');

  test.assert(optional.first === 'default' && optional.second === 'second', 'Undefined argument positions are restored');
  const omitted = await provider.optionalArgument(undefined);

  test.assert(omitted.first === 'default' && Object.hasOwn(omitted, 'second') && omitted.second === undefined, 'Results preserve defaults and explicitly undefined own properties');
  let failure = '';

  try {
    await provider.fail('portable-error');
  } catch (error) {
    failure = String(error);
  }

  test.assert(failure.includes('portable-error'), 'Provider errors reach a standalone consumer');
  const values: (string | undefined)[] = [];
  const events: string[] = [];
  const stopState = provider.currency.subscribe(value => values.push(value));
  const stopEvents = provider.changed.subscribe(value => events.push(value.currency));

  try {
    await provider.changeCurrency('portable');
    await wait(12);
    test.assert(provider.currency.get() === 'portable' && values.includes('portable'), 'Standalone state uses the existing snapshots');
    test.assert(events.includes('portable'), 'Standalone signals use the existing events');
  } finally {
    stopState();
    stopState();
    stopEvents();
    stopEvents();
  }

  await provider.changeCurrency('unsubscribed');
  await wait(12);
  test.assert(!events.includes('unsubscribed'), 'Cleanup stops event delivery');
  let confirmations = 0;
  const result = await provider.purchase({ price: new Money(5), extras: [new Money(2)], pair: [new Money(3), 'quote'], byId: { bonus: new Money(1) } }, async (price, note, ...extras) => {
    confirmations++;
    test.assert(price instanceof Money && extras[0] instanceof Money && note === undefined, 'Callback values are reconstructed in the caller');

    return new Money(price.gold + extras[0].gold);
  });

  test.assert(confirmations === 1 && result instanceof Money && result.gold === 11, 'Custom values and call-scoped callbacks work without Core registration');
  test.assert(await provider.confirmationReleased(), 'Callbacks expire after the public call');
}

async function objects(test: Test): Promise<void> {
  const account = await provider.accounts.open('portable');
  const events: string[] = [];
  const stop = account.changed.subscribe(value => events.push(value.format()));

  try {
    test.assert(await provider.accounts.open('portable') === account, 'Remote object results preserve identity');
    test.assert(await provider.accounts.identity(account, 'portable'), 'Forwarding resolves the original provider object');
    const value = await account.deposit(new Money(4), async (current, amount) => current.gold === 0 && amount.gold === 4);

    await wait(12);
    test.assert(value instanceof Money && account.balance.get()?.gold === 4, 'Remote object methods and state retain their types');
    test.assert(events.includes('4 gold'), 'Remote object events reach standalone consumers');
    await account.close();
    await wait(12);
    test.assert(account.balance.get() === undefined, 'Provider disposal invalidates retained object state');
    let rejected = false;

    try {
      await account.owner();
    } catch {
      rejected = true;
    }

    test.assert(rejected, 'Released objects reject new calls');
  } finally {
    stop();
  }
}

async function nativeReferences(test: Test): Promise<void> {
  await nativeContracts(test);
  const entity = test.spawn('minecraft:pig', { x: 1, y: 2, z: 1 });

  try {
    const found = await provider.world.getEntity(entity.id);

    test.assert(found instanceof Entity && found.id === entity.id, 'Native entity handles resolve locally');
    const result = await provider.world.quote(entity, new Money(3), async (value, price) => {
      test.assert(value instanceof Entity && value.id === entity.id, 'Callback native references resolve in the caller');

      return new Money(price.gold + 1);
    });

    test.assert(result.entity.id === entity.id && result.price instanceof Money && result.price.gold === 4, 'Native and custom values compose');
    const dimension = await provider.world.getDimension('overworld');
    const block = await provider.world.getBlock(dimension, test.worldLocation({ x: 2, y: 1, z: 2 }));

    test.assert(block instanceof Block, 'Native dimensions and block locations resolve locally');
  } finally {
    if (entity.isValid) {
      entity.remove();
    }
  }
}

async function absentOptional(test: Test): Promise<void> {
  let rejected = false;

  try {
    await ping();
  } catch (error) {
    rejected = String(error).includes('core_peer_api_optional');
  }

  test.assert(rejected, 'Missing optional providers reject within the discovery deadline');
}

for (const [name, run] of [['contracts', contracts], ['objects', objects], ['native_references', nativeReferences], ['absent_optional', absentOptional]] as const) {
  register('portable_api', name, (test) => {
    void run(test).then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
  }).structureName('api:empty').tag('portable_api').maxTicks(400);
}
