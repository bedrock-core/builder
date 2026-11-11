import { observable, signal } from '@bedrock-core/observable';
import { Money } from '../api/values';

export const moneyState = observable<Money | undefined>(new Money(1));
export const moneyChanged = signal<{ price: Money }>();
export const currencyState = observable('emerald');
export const currencyChanged = signal<{ currency: string }>();
