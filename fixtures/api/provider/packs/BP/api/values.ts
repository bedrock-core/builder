import type { Codec } from '@bedrock-core/server-runtime';

export class Money {
  static readonly codec: Codec<Money, number> = {
    encode: value => value.gold,
    decode: (gold) => {
      if (typeof gold !== 'number' || !Number.isFinite(gold)) {
        throw new TypeError('invalid gold');
      }

      return new Money(gold);
    },
  };

  constructor(readonly gold: number) {}

  format(): string { return `${this.gold} gold`; }
}
