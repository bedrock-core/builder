# {{DISPLAY_NAME}}

{{DESCRIPTION}}

An [@bedrock-core](https://bedrock-core.drav.dev/) addon with UI, addon
registration, typed config, translations, guides and JSON generation.

## Build

Use Node.js 22.18 or newer. If dependencies were not installed during
scaffolding, run your chosen package manager first:

```sh
yarn install
yarn build
# npm: npm install && npm run build
# pnpm: pnpm install && pnpm build
```

Commit the generated lockfile. Yarn uses `nodeLinker: node-modules`; pnpm
uses a hoisted layout. A first build writes the declarations needed by the
editor into `.bedrock-core/generated/`.
For a nested project created without installation, create an empty `yarn.lock`
before running Yarn so it uses this directory as its project root.

Install the matching local builder archives if its configured version is
unavailable from the registry. The UI stage also needs a toolkit exposing
`buildUiPack` and navigation descriptor registration; use matching local UI
archives when necessary.

Import `core-ui-{{UI_VERSION}}.mcpack` into Minecraft and enable it alongside the
generated addon packs.

Edit display metadata in `config.json` and the addon version in `package.json`.
`bedrockCore.addon` contains stable creator/pack IDs; changing a display name does
not change that identity. Manifests keep stable UUIDs, inherit shared metadata and
reference the other local pack by ID. Locale `meta.*` fields override shared display
defaults when supplied. Registration, generated identifiers and navigation use
`@bedrock-core/generated/project`. Run `typecheck` after the first build.

| Script | Profile | Output |
| --- | --- | --- |
| `build` | `build` | `build/{{PROJECT_NAME}}_bp` and `build/{{PROJECT_NAME}}_rp` |
| `build:test` | `build-test` | `build/test/BP` and `build/test/RP` |
| `watch` | `default` | Minecraft development pack folders |
| `watch:test` | `test` | Minecraft development pack folders with GameTests |
| `plan` | `default` | Print the selected pipeline |
| `lint` | — | Check authored files |

The watch profiles use `%APPDATA%/Minecraft Bedrock/Users/Shared/games/com.mojang/`.
Edit their explicit `export` paths in `config.json` for another installation
or platform. The VS Code debugger paths must match those destinations.

## Authoring

| Feature | Location |
| --- | --- |
| Addon registration | `packs/BP/scripts/main.ts` |
| UI screens | `packs/BP/scripts/UI/screens/*.screen.tsx` |
| Config schema | `packs/BP/scripts/config.ts` |
| Translations | `packs/BP/i18n/en_US.ts` |
| MDX guides | `guides/en_US/` |
| Typed JSON templates | `packs/BP/blocks/`, `packs/BP/entities/` |
| GameTests | `packs/BP/scripts/tests/index.ts` |

The builder runs manifest, generator, guides, i18n, UI compiler and bundler
stages in dependency order. Generated imports such as
`@bedrock-core/generated/i18n/behaviorPack` resolve within the staged build. Authored packs
remain source files; completed packs are exported only after validation.

The normal manifest selects `scripts/main.js`. The GameTest manifest extends
it and selects `scripts/gametest.js`, which imports the addon and its tests.
Only the test profiles declare the beta GameTest module.

Push a stone button in the test world to open the example UI.

MIT © {{AUTHOR}}
