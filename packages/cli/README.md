# @bedrock-core/cli

Scaffold a Minecraft Bedrock addon with builder profiles, TypeScript, ESLint,
translations, guides, typed JSON templates and three example UI screens.
The CLI belongs to the [builder repository](https://github.com/bedrock-core/builder).

## Run from this checkout

Install the repository dependencies, then run:

```sh
corepack yarn scaffold my-addon --author "Your Name" --description "My addon" --package-manager none
```

Node.js 22.18 or newer is required. The package-manager choices are `yarn`,
`npm`, `pnpm` and `none`. Each flag skips its corresponding prompt.
The CLI initializes Git without creating a commit and refuses nonempty directories.
The Yarn choice creates a project lockfile before installation so a scaffold
inside another Yarn checkout is treated independently. After choosing `none`,
create an empty `yarn.lock` before installing with Yarn in a nested directory.

The checkout keeps its packages private. `yarn pack-release` prepares local
archives, including this CLI and the builder packages. Install the local builder
archives in generated projects when the configured version is not available
from the registry.

The UI stage requires a matching toolkit with `buildUiPack` and navigation
descriptor registration. Use compatible local UI archives when the installed
registry packages do not provide these APIs.

## Generated project

`config.json` declares stable creator/pack IDs, display metadata, named packs and four builder profiles.
The namespace is derived from those IDs. `package.json` owns the npm name and addon version;
native manifests inherit version/engine/author defaults and refer to local packs by ID.
Runtime registration imports `addonManifest` from `@bedrock-core/generated/project`.
Scripts use `core-builder` from the project's `@bedrock-core/builder` development
dependency; build tools are installed with the other npm dependencies.

| Task | Yarn | npm | pnpm |
| --- | --- | --- | --- |
| Build | `yarn build` | `npm run build` | `pnpm build` |
| Build GameTests | `yarn build:test` | `npm run build:test` | `pnpm build:test` |
| Watch | `yarn watch` | `npm run watch` | `pnpm watch` |
| Watch GameTests | `yarn watch:test` | `npm run watch:test` | `pnpm watch:test` |

Release packs go to `build/<project>_bp` and `build/<project>_rp`; GameTest
packs go to `build/test/BP` and `build/test/RP`. The watch profiles export to
the Windows Minecraft development folders through `%APPDATA%`. Change those
explicit destinations for another client installation or platform.

Translations live in `packs/BP/i18n/` and MDX guides in `guides/`. Builder stages
write editor declarations under `.bedrock-core/generated/`; run a build
before typechecking the project. Build-time generated imports are resolved by
the builder.

Use `--preset full` (default) for the complete framework starter, `--preset script` for
plain Minecraft scripting with a linked resource pack, or `--preset resource` for one
resource pack. The minimal presets install no Core runtime packages. Use `--display-name`
for a human-readable name and `--creator-id`/`--pack-id` to override stable identifiers.
The full and script starters include `typecheck`; run the first build before typechecking.

The template pins an exact UI version. The CLI downloads the corresponding
`core-ui-<version>.mcpack` from the UI repository and prints its matching
release link if download fails. Import the render pack into the test world.

## Template maintenance

Run `yarn sync:cli [path/to/ui-checkout]` to synchronize the builder and UI
dependency versions and both behavior manifests' render-pack dependency.
The default UI checkout is the adjacent `../ui` repository.

Run `yarn test:cli` for offline scaffold checks. `yarn smoke:cli <cli.tgz>`
tests the packed CLI with npm, Yarn and pnpm, builds both profiles and runs
the scaffold's GameTest through BDS on Linux.

MIT; see [LICENSE](./LICENSE).
