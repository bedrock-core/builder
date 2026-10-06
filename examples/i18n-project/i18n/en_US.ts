import { shopName } from '../shared/labels.ts';

export default {
  meta: {
    name: shopName,
    description: 'An example with typed translation resources.',
  },
  shop: {
    title: shopName,
    bought: 'Bought {{item}} for {{price}} emeralds.',
    intro: 'Welcome to $t(shop.title).',
    stock_one: '{{count}} item in stock',
    stock_other: '{{count}} items in stock',
  },
} as const;
