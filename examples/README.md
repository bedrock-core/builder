# @bedrock-core/builder examples

Each child directory is an independent addon project. This directory contains no addon config
or entry point.

| Project | Purpose | Entry |
| --- | --- | --- |
| `script-only` | Bundle a TypeScript behavior-pack script | `packs/BP/scripts/main.ts` |
| `plugin-project` | Generate and consume JSON through build hooks | `build/items.ts` is a build plugin; this data-only BP has no runtime script |

Each project owns its config.json, pack manifests and dist directory.

```sh
yarn build examples/script-only/config.json
yarn build examples/plugin-project/config.json
```
