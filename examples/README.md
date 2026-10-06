# @bedrock-core/builder examples

Each child directory is an independent addon project. This directory contains no addon config
or entry point.

| Project | Purpose | Entry |
| --- | --- | --- |
| `script-only` | Bundle a TypeScript behavior-pack script | `packs/BP/scripts/main.ts` |
| `multi-pack` | Build two behavior packs from shared TypeScript inputs | Each manifest selects its matching TypeScript source |
| `generator-project` | Generate typed loot tables from shared JSON and bundle a script | `packs/gameplay/scripts/main.ts` |
| `plugin-project` | Generate and consume JSON through build hooks | `build/items.ts` is a build plugin; this data-only BP has no runtime script |

Each project owns its config.json, v3 pack manifests and dist directory. The `script-only`
project has a `tests` profile that overrides its staged manifest entry. Deployment is disabled
in these examples; configure `deploy` explicitly to install their packs.

```sh
yarn build examples/script-only/config.json
yarn build examples/script-only/config.json tests
yarn build examples/plugin-project/config.json
yarn build examples/multi-pack/config.json
yarn build examples/generator-project/config.json
```
