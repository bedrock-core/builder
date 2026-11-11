# Releasing

Builder packages and the scaffold CLI publish separately. Stable versions use
the npm `latest` tag; prereleases use `next`. Both local npm authentication and
GitHub Actions trusted publishing use the npm CLI to publish verified tarballs.

Each Builder stage and plugin has an independent Changesets version. A release
updates packages selected by changesets and dependents that need updated dependency
versions. Unaffected plugins keep their current versions.
Publication and tagging skip versions with existing package release tags. Fetch
all release tags before running these commands.

## Version and verify

Apply queued Changesets, update the lockfile, and commit the resulting versions
and changelogs before publishing:

```sh
yarn version:packages
yarn install
yarn release
yarn publish-release --scope builder --dry-run
```

`yarn release` runs offline checks, creates archives and verifies their installed
APIs. Publication also compares each archive with its verification receipt and a
fresh pack of the current source. Builder packages publish in dependency order.

## Publish Builder packages

Authenticate with npm locally, then publish and tag the Builder package group:

```sh
npm login --registry https://registry.npmjs.org
yarn publish-release --scope builder
yarn tag-release --scope builder
```

Push the release commit and annotated tags to the repository. The CLI is excluded
from this package group. An existing registry version is accepted only when its
archive integrity matches the checked tarball.

## Publish the CLI

Publish its runtime dependencies and matching shared UI resource pack first.
After applying the owning repositories' versions, synchronize the starter:

```sh
yarn sync:cli
yarn release
```

The Linux CLI workflow tests the packed CLI with npm, Yarn and pnpm. It creates
full, script-only and resource-only projects against registry dependencies.
Its report and the exact tested tarball are required for CLI publication:

```sh
yarn publish-release --scope cli
yarn tag-release --scope cli
```

Set `BEDROCK_CLI_TARBALL` and `BEDROCK_CLI_SMOKE_SUMMARY` to the tested artifact
and passing report. File-backed Builder smoke tests do not satisfy this gate.

## GitHub Actions

Pushes to main maintain the Changesets version PR. A manual Release run selects
either Builder or CLI publication after that PR has merged. Configure npm trusted
publishing for the repository and `.github/workflows/publish.yml` before using
the workflow's publish job. Version PR creation does not publish packages.

## Package contents and native acceptance

Use Node.js 26.13.0 or newer. Install Corepack with `npm install --global corepack`
and enable it with `corepack enable` to run the repository's pinned Yarn.
Published packages expose JavaScript and declarations through explicit exports.
Archives and integrity receipts live under
`.bedrock-core/release/tarballs/`.

Acceptance uses the fixture's real runtime dependencies. Install them before
running the source checks:

```sh
npm install --prefix fixtures/acceptance --ignore-scripts --package-lock=false
yarn acceptance
```

To test against a workspace's matching toolkit dependencies, point
`BUILDER_ACCEPTANCE_DEPENDENCY_ROOT` at the project containing `node_modules`:

```powershell
$env:BUILDER_ACCEPTANCE_DEPENDENCY_ROOT = 'C:/path/to/toolkit-project'
yarn acceptance
```

Without that override, acceptance uses fixture-local dependencies, then the
Builder checkout's dependencies. Installed-package verification resolves the
fixture dependencies alongside the Builder archives under test.

With the override set, `yarn test:packages` checks extracted Builder archives
against those installed dependencies without a package-manager install. It writes
`verified-local.json`. The registry-backed run writes `verified.json`, which is
the publication gate.

The acceptance fixtures cover distinct integration boundaries:

| Fixture | Command | Coverage |
| --- | --- | --- |
| `acceptance` | `yarn acceptance` | Content, guides, translations, UI and cold/warm builds |
| `api` | `yarn acceptance:api` | Provider/consumer isolation, API contracts and dependency manifests |
| `api-package` | `yarn acceptance:api-packages` | Installed API archives, standalone clients and provider handover |
| `navigation-api` | `yarn acceptance:navigation-api` | Screen discovery, cross-addon handoff, Back and owned withdrawal |

Install dependencies under `fixtures/api` or `fixtures/navigation-api` for their
standalone checks, or select a matching toolkit project through the same override.
The fixture minimum versions follow the public contracts they exercise.

Native acceptance uses Builder's `bds-runner.json`, the fixed `gametest` instance
under `.bds/server/`, and its configured UDP port pair. Run the suites sequentially.
The workspace's local-only firewall setup must cover that executable before launch.

```powershell
$env:BUILDER_BDS_RUNNER = 'C:/tools/bds-runner/bin/bc-bds.mjs'
yarn acceptance:native
```

The runner uses the repository cache. `BC_BDS_PATH` can select an explicitly
managed source build; executable instances and logs remain under this repository's
`.bds/` unless the operator supplies another home.

Its two GameTests cover generated engine content, registered guide pages and
authored translations.
It does not establish rendered JSON UI or client interaction.

The addon API fixture requires matching Server Runtime dependencies with the
public API binding contract. Set `BUILDER_ACCEPTANCE_DEPENDENCY_ROOT` to the
project containing those dependencies:

```powershell
yarn acceptance:api
yarn acceptance:api:native
```

The first command verifies provider and consumer cold/warm builds, consumer
implementation isolation and native required/optional pack requirements. The
native command runs the API GameTests in separate script realms. It
checks normal imports, argument tuples, undefined values, nested methods,
immutable constants and manifest metadata, provider errors, synchronized state,
event subscriptions and absent optional addons. Results are written under
`.bedrock-core/api-acceptance/`. Installed dependency ranges and package
archives must be verified against the matching Runtime release.

Use `yarn acceptance:api-packages:native` and
`yarn acceptance:navigation-api:native` for the portable client and Navigation
fixtures. Their source and bundle receipts live under `.bedrock-core/api-package/`
and `.bedrock-core/navigation-api/` respectively. Headless acceptance does not
establish rendered UI or client interaction.
