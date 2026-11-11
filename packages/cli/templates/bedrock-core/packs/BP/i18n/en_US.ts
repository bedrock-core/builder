/** Default locale resources. Import translated locales in i18n/index.ts. */
export default {
  pack: { name: '{{DISPLAY_NAME}}', description: '{{DESCRIPTION}}' },
  example: {
    greeting: 'Hello {{name}}, welcome back!',
    // Plural leaf: `_one`/`_other` collapse into `example.points` taking `count`.
    points_one: 'You have {{count}} point',
    points_other: 'You have {{count}} points',
  },
} as const;
