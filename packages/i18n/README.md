# @bedrock-core/builder-i18n

Compile TS/JS default-exported translation objects into language files, a runtime JSON bundle
and editor declarations. This private native TypeScript package runs on Node 22.18 or later.
Its only build dependency is the shared `@bedrock-core/builder-bundler` package and esbuild.
Resource modules may import additional project dependencies. The runner, UI system and server
framework are optional.

## Standalone API

```ts
import { compileI18n } from '@bedrock-core/builder-i18n';

const result = await compileI18n({
  root: '/path/to/project',
  namespace: 'creator_shop',
  packs: [
    { path: './packs/gameplay', kind: 'behavior' },
    { path: './packs/visuals', kind: 'resource' },
  ],
});
```

Pack paths are explicit and relative to `root` unless absolute. Any number of behavior or
resource packs is supported; omitting packs still generates the runtime bundle and types.
The builder adapter classifies packs from their staged manifests and defaults the namespace
to project config. Standalone callers supply a namespace using lowercase letters, numbers
and underscores.

`result` contains `bundle`, `bundlePath`, emitted `files`, consumed `inputs`, editor
`declarations` and `warnings`. With no locale modules it returns a no-op result. Successful
compilation writes files; resource validation finishes before any pack or declaration changes.
Existing language content is preserved outside the generated section. Sources execute as
trusted Node code. An AbortSignal supports cooperative cancellation.

## Resources

Place one `<xx_YY>.ts` or `.js` module in `i18n/`:

```ts
export default {
  meta: { name: 'Shop', description: 'Sells items to players' },
  shop: {
    title: 'Shop',
    bought: 'Bought {{item}} for {{price}} emeralds.',
    intro: 'Welcome to $t(shop.title).',
    stock_one: '{{count}} item',
    stock_other: '{{count}} items',
  },
} as const;
```

`as const` retains literal template types for key and interpolation inference. Resource
modules support relative TS/JS/JSON imports, installed packages, Node built-ins and asynchronous
evaluation. Keep helper modules outside the locale directory. `.mts` and `.mjs` are supported;
each locale must have a single module. Values are single-line strings, segments use
`A-Za-z0-9_`, and nesting has a six-level limit.

The default locale defines the key shape. Strict mode rejects missing/extra keys, variable
drift, unknown nesting references and plural groups without `_other`. With `strict: false`,
parity gaps fall back to the default locale, extra keys are dropped, and unknown/cyclic `$t()`
references become empty strings with warnings. Invalid resource shapes and variables that
cannot map to recorded positional arguments always fail. Locale-only plural categories are
allowed when the default locale declares the group's `_other` form.

`{{variables}}` become `%N$s` in `.lang` entries using the default locale's argument order;
translations may reorder words. `$t(path)` is recursively inlined. Runtime tables keep
`{{variables}}`. Resource packs receive namespaced translations, library keys and vanilla
overrides. Behavior packs receive only `pack.name` and `pack.description` aliases from
`meta.name` and `meta.description`; resource packs also receive those aliases. Existing
`texts/languages.json` locales are retained. Handwritten language values are included in
the runtime bundle's `extra` tables, merging resource packs first and behavior packs second
in their configured order.

## Libraries and vanilla

Installed dependencies declare resources and type exports with:

```json
{
  "bedrockCore": { "i18n": { "dir": "./src/i18n", "namespace": "core" } },
  "exports": { "./i18n/*": "./src/i18n/*.ts" }
}
```

Discovery traverses dependencies, including non-declaring packages. Root devDependencies
count; transitive devDependencies do not. Multiple libraries may share a namespace;
conflicting values fail. Unavailable locales and keys fall back to that namespace's default
table. Own branches matching a library namespace are overrides of existing paths and must
retain its interpolation variables. The `vanilla` namespace is reserved.

`vanilla: true` fetches Mojang's language files and caches them under
`.bedrock-core/cache/i18n`. The default locale must be available; other fetch failures warn
and fall back to it. Declarations expose the full vanilla key tree. Runtime tables include
only keys found as literals or `vanilla.*` selector chains in behavior-pack scripts and
library `src` files. Computed keys are not detected by this scan. Vanilla translations
are written into resource packs only for authored `vanilla` overrides, under their original
keys. Vanilla support is disabled by default and performs no downloads while disabled.

## Options and integration

| Option | Default | Purpose |
| --- | --- | --- |
| `sourceDir` | `i18n` | Directory of locale modules |
| `defaultLocale` | `en_US` | Shape and argument-order reference |
| `strict` | `true` | Treat translation consistency problems as errors |
| `types` | `true` | Generate editor declarations |
| `pretty` | `false` | JSON indentation, `{ indent: 'space' \| 'tab', size: number }` |
| `vanilla` | `false` | Optional vanilla fetch, typing and usage scan |
| `cacheMaxAgeHours` | `24` | Vanilla cache freshness |
| `vanillaLangUrlTemplate` | Mojang bedrock-samples | Language URL containing `{locale}` |
| `tsconfig` | Automatic discovery | Explicit resource compiler configuration |

Standalone path options are `outputDir` (default `.bedrock-core/generated/i18n`), `typesDir`
(defaults to outputDir), `cacheDir`, `dependencyRoot` and `declarationRoot` (for staging).
`aliases` supplies generated import paths to standalone callers; the adapter uses registered
producer import names automatically. `warn` receives diagnostic strings. The adapter keeps declarations and caches in the authored
project's `.bedrock-core` directory and runtime JSON in the temporary generated workspace.
Include `.bedrock-core/generated/i18n/**/*.d.ts` in your tsconfig after the first build;
declarations use two spaces and reference authored literal resources and library type exports.

The adapter provides `i18n:bundle` and `i18n:<packId>:texts/<filename>` artifacts. It consumes
staged project resources and existing pack language files, so content-producing hooks belong
before i18n. Default locale modules activate the stage automatically. Its producer registration makes
`@bedrock-core/generated/i18n` resolve to
the current build's `i18n:bundle`. Scripts need no alias configuration. Imports whose producing
stage is disabled fail with a missing-producer error.

The bundle has the `namespace`, `defaultLocale`, `libs`, `args`, `extra` and `locales` fields
consumed by `@bedrock-core/i18n`. `resources` exists only in types. Install that runtime package
when using its translation helpers; reading the bundle directly requires no runtime library.
