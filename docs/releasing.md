# @bedrock-core release packages

The repository prepares `@bedrock-core/builder` and independently installable
packages: `builder-plugin`, `builder-manifest`, `builder-bundler`, `builder-generator`,
`builder-guides`, `builder-i18n`, `builder-ui` and `builder-validation`, all under the
`@bedrock-core` scope.
It also prepares `@bedrock-core/cli`, the addon scaffold command. Its template
pins the builder version and an exact UI/render-pack pair; `yarn sync:cli` updates
those inputs from this checkout and the adjacent UI repository.
The builder depends on these packages to supply its automatic stages. Install a
standalone package when a tool needs only that function; its README lists build-time
dependencies and any runtime requirements of generated output.

The repository remains local and all package manifests are private. `yarn release`
runs the local checks and prepares archives without publishing anything.

Source development runs typed TypeScript directly on Node 22.18 or newer. Published
packages expose JavaScript and declarations because Node does not strip TypeScript
inside `node_modules`. Yarn's `publishConfig` exports select the release files;
checkout exports select the authored sources. Worker entry points support both forms.

Each package lists its export paths explicitly. Built-in transformations expose `./plugin`
using the shared plugin contract. Helpers and workers stay inside their owning packages;
implementation files are unavailable through unlisted package subpath imports.

## Record and apply package versions

Use Changesets to describe caller-visible changes and select the affected packages:

```sh
yarn changeset
yarn changeset:status
```

The builder and its `builder-*` packages form a fixed version group. The CLI keeps
its own version. The root builder package participates through the `.` workspace.
Private packages are versioned for local archives; Changesets does not tag them.

Apply the queued versions and changelogs when preparing a release, then synchronize
the CLI template's builder and UI/render-pack pins:

```sh
yarn version:packages
yarn sync:cli
yarn install
```

Review the versioned manifests, template pins and changelogs together. Versioning
does not publish packages. Use the checked archive publication flow below for
registry releases.

## Check and pack

```sh
yarn install --immutable
yarn check
yarn acceptance
yarn pack-release
yarn test:packages
```

The acceptance fixture builds a behavior pack and two resource packs with generated
items, loot, translations and guides. It checks unchanged builds, script edits and
imported-data edits. It uses a temporary project and leaves authored fixtures intact.
Package checks install the actual tarballs in a clean consumer, exercise APIs, a worker,
the CLI and strict declarations, and reject cache files and unresolved workspace protocols.
Archives are written to `.bedrock-core/release/tarballs/` with an index.

The CI matrix checks Windows and Linux on Node 22.18 and 24. Native acceptance is a
separate command because it needs a Bedrock Dedicated Server installation:

```powershell
$env:BUILDER_BDS_RUNNER = 'C:/tools/bds-runner/bin/bc-bds.mjs'
$env:BC_BDS_PATH = 'C:/tools/bedrock-server'
yarn acceptance:native
```

The native runner uses `.bedrock-core/acceptance/bds/`, port 19773 and a fresh isolated
world. Two GameTests verify engine registration of the generated item and runtime access
to generated loot, guide and translation imports. Server acceptance does not test rendered
JSON UI or client interaction. Keep client validation separate from this gate.

## Registry publication

The preview archive version is `0.1.0-alpha.0`. Registry publication is disabled while
any package is private. To enable a future public release, set all package manifests
to public, configure their repository metadata, authenticate through Yarn, and run:

```sh
yarn npm login --scope bedrock-core
yarn release
yarn publish-release
```

The publication script uses public access and the `next` tag, publishes dependencies
before the builder and verifies each
registry tarball's integrity against the checked archive. Repeating a partial release
skips only identical published versions; a different registry archive fails. Version
changes must be applied through Changesets before preparing new archives.
Never change the source, metadata or built files between package verification and publication.
