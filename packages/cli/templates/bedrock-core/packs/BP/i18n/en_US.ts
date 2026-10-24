/**
 * Your addon's text, TS-first. The i18n builder stage turns this into
 * namespaced .lang entries, a typed runtime bundle, and autocompletion for
 * every key and interpolation variable. This default locale's shape is the
 * contract: add es_ES.ts (etc.) with exactly these paths to translate.
 *
 * `pack.name`, `pack.description` and `pack.creator` default to config.json.
 * Add a pack branch here or in another locale to translate these display fields.
 */
export default {
  example: {
    greeting: 'Hello {{name}}, welcome back!',
    // Plural leaf: `_one`/`_other` collapse into `example.points` taking `count`.
    points_one: 'You have {{count}} point',
    points_other: 'You have {{count}} points',
  },
} as const;
