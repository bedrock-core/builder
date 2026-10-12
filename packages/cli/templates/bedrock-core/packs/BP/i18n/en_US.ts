/**
 * Your addon's text, TS-first. The i18n builder stage turns this into
 * namespaced .lang entries, a typed runtime bundle, and autocompletion for
 * every key and interpolation variable. This default locale's shape is the
 * contract: add es_ES.ts (etc.) with exactly these paths to translate.
 *
 * `meta.name`, `meta.description` and `meta.creator` default to config.json.
 * Add a meta branch here or in another locale to override those display fields.
 */
export default {
  example: {
    greeting: 'Hello {{name}}, welcome back!',
    // Plural leaf: `_one`/`_other` collapse into `example.points` taking `count`.
    points_one: 'You have {{count}} point',
    points_other: 'You have {{count}} points',
  },
} as const;
