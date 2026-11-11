import { core } from '@bedrock-core/server-runtime';
import { observable, signal } from '@bedrock-core/observable';
import type { ReadonlyObservable, Signal } from '@bedrock-core/observable';
import { Money } from './values';

export interface Account {
  readonly balance: ReadonlyObservable<Money | undefined>;
  readonly changed: Signal<Money>;
  owner(): Promise<string>;
  deposit(amount: Money, confirm: (current: Money, amount: Money) => Promise<boolean>): Promise<Money>;
  close(): Promise<void>;
}

class LocalAccount implements Account {
  private readonly current = observable(new Money(0));
  private readonly updates = signal<Money>();
  readonly balance: ReadonlyObservable<Money | undefined> = this.current;
  readonly changed: Signal<Money> = this.updates;

  constructor(private readonly key: string) {}

  async owner(): Promise<string> {
    if (core.namespace !== 'core_peer_api_provider') {
      throw new Error('account-implementation-ran-in-consumer');
    }

    return core.namespace;
  }

  async deposit(amount: Money, confirm: (current: Money, amount: Money) => Promise<boolean>): Promise<Money> {
    if (!(amount instanceof Money)) {
      throw new TypeError('account deposit requires Money');
    }

    if (await confirm(this.current.get(), amount)) {
      const value = new Money(this.current.get().gold + amount.gold);

      this.current.set(value);
      this.updates.emit(value);
    }

    return this.current.get();
  }

  async close(): Promise<void> {
    accountsByKey.delete(this.key);
    core.api.release(this);
  }
}

const accountsByKey = new Map<string, LocalAccount>();

export const accounts = {
  async withAccount(callback: () => Promise<Account>): Promise<string> {
    return await (await callback()).owner();
  },
  async open(key: string): Promise<Account> {
    let account = accountsByKey.get(key);

    if (account === undefined) {
      account = new LocalAccount(key);
      accountsByKey.set(key, account);
    }

    return account;
  },
  async identity(account: Account, key: string): Promise<boolean> {
    return accountsByKey.get(key) === account;
  },
};
