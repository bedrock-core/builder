# @bedrock-core i18n example

From the builder repository:

```sh
yarn build examples/i18n-project/config.json
yarn exec tsc --project examples/i18n-project/tsconfig.json
yarn watch examples/i18n-project/config.json
```

The script entry comes from `packs/gameplay/manifest.json`. Importing
`@bedrock-core/generated/i18n` automatically consumes the current build's `i18n:bundle` artifact.
Locale modules and manifest script entries automatically activate their stages. This example
needs no stage selection or alias configuration. No framework runtime package is required to
inspect that JSON; install `@bedrock-core/i18n` when using its translation helpers.

Locale modules default-export nested objects with `as const`. The English module imports a
shared TypeScript constant. Czech reorders interpolation arguments and adds its `_few` plural
category. Resource-pack language files receive the translations; both packs receive
`pack.name` and `pack.description` aliases. Existing handwritten language entries are retained.

Build once to generate the editor declaration, which this project's tsconfig includes from
`.bedrock-core/generated/i18n`. Exported packs are under `dist/gameplay` and `dist/visuals`.
