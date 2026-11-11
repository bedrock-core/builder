import { core } from '@bedrock-core/server-runtime';
import { observable, signal, toSignal, type ReadonlyObservable, type Signal, type NativeSignal } from '@bedrock-core/observable';
import { currencyChanged, currencyState, moneyChanged, moneyState } from '../scripts/state';
import { Money } from './values';
import { world } from './world';
import { native } from './native';
import { accounts } from './accounts';

export { Money } from './values';
export { world } from './world';
export { native } from './native';
export { accounts } from './accounts';
export type { Account } from './accounts';

export const currency: ReadonlyObservable<string | undefined> = currencyState;
export const changed: Signal<{ currency: string }> = currencyChanged;
export const funds: ReadonlyObservable<Money | undefined> = moneyState;
export const quoted: Signal<{ price: Money }> = moneyChanged;
const explicitValue = observable<number | undefined>(0);
const explicitEvents = signal<number>();
const eventStops = new Map<(value: number) => void, () => void>();

export const signalCount: ReadonlyObservable<number | undefined> = explicitValue;
const nativeChanged: NativeSignal<number> = {
  subscribe(listener) {
    eventStops.get(listener)?.();
    eventStops.set(listener, explicitEvents.subscribe(listener));
  },
  unsubscribe(listener) {
    eventStops.get(listener)?.();
    eventStops.delete(listener);
  },
};

export const explicitChanged: Signal<number> = toSignal(nativeChanged);

export async function emitExplicit(value: number): Promise<void> {
  explicitValue.set(value);
  explicitEvents.emit(value);
}

export const info = { name: 'api-fixture', revision: 1, nested: { enabled: true } } as const;

export async function ownerNamespace(): Promise<string> {
  if (core.namespace !== 'core_peer_api_provider') {
    throw new Error('provider-implementation-ran-in-consumer');
  }

  return core.namespace;
}

export async function changeCurrency(value: string): Promise<string> {
  currencyState.set(value);
  currencyChanged.emit({ currency: value });

  return currencyState.get();
}

export async function optionalArgument(first = 'default', second?: string): Promise<{ first: string; second: string | undefined }> {
  return { first, second };
}

export async function fail(message: string): Promise<never> {
  throw new Error(message);
}

let lastConfirmation: ((price: Money, note?: string, ...alternatives: Money[]) => Promise<Money>) | undefined;

export async function purchase(
  request: { price: Money; extras: Money[]; pair: [Money, string]; byId: Record<string, Money> },
  confirm: (price: Money, note?: string, ...alternatives: Money[]) => Promise<Money>,
): Promise<Money> {
  if (!(request.price instanceof Money) || !(request.extras[0] instanceof Money) || !(request.pair[0] instanceof Money)
    || !(request.byId.bonus instanceof Money)) { throw new Error('provider values were not reconstructed'); }

  lastConfirmation = confirm;
  const price = new Money(request.price.gold + request.pair[0].gold + request.byId.bonus.gold);
  const result = await confirm(price, undefined, ...request.extras);

  if (!(result instanceof Money)) {
    throw new Error('callback result was not reconstructed');
  }

  moneyState.set(result);
  moneyChanged.emit({ price: result });

  return result;
}

export async function confirmationReleased(): Promise<boolean> {
  if (lastConfirmation === undefined) {
    return false;
  }

  try {
    await lastConfirmation(new Money(1));

    return false;
  } catch (error) {
    return String(error).includes('call has ended');
  }
}

export const API = {
  Money, world, native, accounts, info,
  currency: currencyState,
  changed: currencyChanged,
  funds: moneyState,
  quoted: moneyChanged,
  signalCount: explicitValue,
  explicitChanged,
  ownerNamespace, changeCurrency, optionalArgument, fail, purchase, confirmationReleased, emitExplicit,
};
