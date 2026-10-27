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

Source development runs TypeScript on Node 22.18 or newer. Published packages
expose JavaScript and declarations through explicit exports; workers support
both forms. Archives and integrity receipts live under
`.bedrock-core/release/tarballs/`.

Native Builder acceptance uses an isolated BDS world and port 19773:

```powershell
$env:BUILDER_BDS_RUNNER = 'C:/tools/bds-runner/bin/bc-bds.mjs'
$env:BC_BDS_PATH = 'C:/tools/bedrock-server'
yarn acceptance:native
```

Its two GameTests cover generated engine content and runtime imports.
It does not establish rendered JSON UI or client interaction.
