import { core } from '@bedrock-core/server-runtime';
import { observable, signal } from '@bedrock-core/observable';
import { system } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import { accounts, Money, ownerNamespace, type Account } from '@bedrock-core/api-provider';
import manifest from '../manifest.json';

const wait = (ticks: number): Promise<void> => new Promise(resolve => system.runTimeout(resolve, ticks));

class ConsumerAccount implements Account {
  readonly balance = observable<Money | undefined>(new Money(0));
  readonly changed = signal<Money>();

  async owner(): Promise<string> { return core.namespace; }
  async deposit(amount: Money): Promise<Money> { return amount; }
  async close(): Promise<void> { core.api.release(this); }
}

async function handover(test: Test): Promise<void> {
  const account = await accounts.open('handover');
  const states: number[] = [];
  const events: number[] = [];
  const stopState = account.balance.subscribe((value) => {
    if (value !== undefined) {
      states.push(value.gold);
    }
  });
  const stopEvents = account.changed.subscribe(value => events.push(value.gold));
  const owned = new ConsumerAccount();
  let confirmations = 0;

  try {
    const owner = await accounts.withAccount(async () => {
      confirmations++;
      core.register({ manifest });
      test.assert(await ownerNamespace() === 'core_peer_api_provider', 'New calls use the registered connection during a pending callback');
      test.assert(await accounts.open('handover') === account, 'Retained handles preserve identity across registration');
      test.assert(await accounts.identity(account, 'handover'), 'Retained handles can be forwarded through the registered connection');
      test.assert(await account.owner() === 'core_peer_api_provider', 'Retained methods follow the registered connection');

      return owned;
    });

    test.assert(owner === manifest.namespace && confirmations === 1, 'Pending callbacks can return objects owned by the registered Core');
    const result = await account.deposit(new Money(6), async (current, amount) => {
      test.assert(current instanceof Money && current.gold === 0 && amount.gold === 6, 'Callbacks retain typed values');

      return true;
    });

    await wait(12);
    test.assert(result instanceof Money && result.gold === 6 && confirmations === 1, 'Pending calls and callbacks complete once');
    test.assert(account.balance.get()?.gold === 6 && states.includes(6), 'Retained state follows the registered connection');
    test.assert(events.length === 1 && events[0] === 6, 'Retained event subscriptions deliver once');
    await account.close();
    await wait(12);
    test.assert(account.balance.get() === undefined, 'Provider disposal invalidates retained state');
    let rejected = false;

    try {
      await accounts.identity(account, 'handover');
    } catch {
      rejected = true;
    }

    test.assert(rejected, 'Disposed handles cannot be forwarded after handover');
  } finally {
    stopState();
    stopEvents();
    core.api.release(owned);
    core.stop();
  }
}

register('portable_handover', 'late_core', (test) => {
  void handover(test).then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
}).structureName('api:empty').tag('portable_handover').maxTicks(400);
