export default {
  meta: {
    name: 'Obchod',
    description: 'Příklad s typovanými překlady.',
  },
  shop: {
    title: 'Obchod',
    bought: 'Za {{price}} smaragdů koupen {{item}}.',
    intro: 'Vítejte: $t(shop.title).',
    stock_one: '{{count}} kus skladem',
    stock_few: '{{count}} kusy skladem',
    stock_other: '{{count}} kusů skladem',
  },
} as const;
