import { API, currency, changed, ownerNamespace, Money, accounts } from '@bedrock-core/api-provider';
import type { Account } from '@bedrock-core/api-provider';

const amount: number = new Money(3).gold;
const owner: Promise<string> = ownerNamespace();

void amount;
void owner;
const groupedAmount: number = new API.Money(3).gold;
const groupedCurrency: string | undefined = API.currency.get();
const groupedMoney: Money = new API.Money(3);
const groupedAccount: Promise<Account> = API.accounts.open('typed');

void groupedAmount;
void groupedCurrency;
void groupedMoney;
void groupedAccount;

// @ts-expect-error Generated API object state does not expose its writable source.
API.currency.set('gold');
// @ts-expect-error Generated API object signals do not expose the provider emitter.
API.changed.emit({ currency: 'gold' });
// @ts-expect-error Grouped value constructors retain their argument contract.
new API.Money('three');

// @ts-expect-error Public argument types survive package publication.
new Money('three');
// @ts-expect-error Public callable signatures do not become any.
ownerNamespace('extra');
// @ts-expect-error Consumers receive readonly state.
currency.set('gold');
// @ts-expect-error Consumers receive subscription-only signals.
changed.emit({ currency: 'gold' });
// @ts-expect-error Remote object factories remain asynchronous.
accounts.open('key').deposit(new Money(2), async () => true);
