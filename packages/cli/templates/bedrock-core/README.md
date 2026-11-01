# {{DISPLAY_NAME}}

{{DESCRIPTION}}

| Command | Result |
| --- | --- |
| `build` | Export the completed packs to `build/` |
| `watch` | Rebuild into Minecraft development folders after changes |
| `lint` | Check source files, Core hook ordering, effect dependencies and render behavior |
| `test:mc` | Build the test packs and run the included GameTest on BDS |
| `build:optimized` | Build and optimize packs into `dist/` |
| `bds:fetch` | Download the server pinned in `bds-runner.json` |
| `bds:where` | Inspect the server selection |

Run commands with `npm run`, `yarn` or `pnpm`. Import the matching shared UI resource pack into the world for client testing.

[Lint components and hooks](https://bedrock-core.drav.dev/docs/ui/guides/linting) describes the Core preset added to `eslint.config.mjs`.

https://bedrock-core.drav.dev/docs/cli
