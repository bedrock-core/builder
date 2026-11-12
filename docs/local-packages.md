# Local package development

Use the project-owned npm registry to build unpublished Core packages and verify
them through ordinary registry installs. Run the commands from the Builder
checkout with Node.js 26.13.0 or newer and its pinned Yarn installed.

## Registry lifecycle

```sh
yarn registry start
yarn registry status
yarn registry stop
```

Start launches the pinned Verdaccio development dependency on
`http://127.0.0.1:4873`, including its package browser. Repeated starts reuse the
running instance. Stop checks
the instance identity and asks that server to shut down; it does not terminate
processes found through a port or a saved PID.

Use `--port 4874` to select another port and `--state <directory>` to select another
state directory. Pass that state directory to subsequent registry and package
commands. An occupied port reports an error and leaves its service running.

Storage, local authentication, logs, snapshots and receipts live under
`.bedrock-core/local-registry/`. Stop the registry before removing its state.
Authentication is prepared automatically for this loopback registry.

## Publish a source snapshot

Replace the repository path with the producer checkout:

```sh
yarn local:publish --repo <server-checkout> --build build:libs
```

The producer must have public `@bedrock-core/*` workspaces, a Changesets
configuration, a pinned Yarn 4 release and the selected build script. That script
must prepare package files without publishing them.

Snapshot capture includes tracked working-tree edits and non-ignored source files.
Dependency directories, local state and environment/authentication files are
excluded. Changesets assigns calculated snapshot versions in an isolated copy;
fixed package groups remain coordinated. Yarn builds and packs that copy, then
the helper verifies all archives and publishes dependencies before dependents
using the local dist-tag. The source checkout keeps its authored package versions
and lockfile.

The printed receipt contains the captured source identity, exact snapshot
versions, archive paths and SHA-512 integrity. Use that receipt to select a build;
the moving local dist-tag does not identify the bytes under test.

## Verify a consumer

Use the printed snapshot receipt and an explicit consumer checkout:

```sh
yarn local:check --receipt <snapshot-receipt> --consumer <builder-checkout> --fixture fixtures/api --check acceptance:api-packages
```

The helper copies the consumer's source, provides the selected snapshot packages
and optional fixture dependencies, and installs them through the registry. Each
run has its own Yarn cache with global cache/mirror reuse disabled. An immutable
install with cache verification precedes checks of registry integrity and every
installed archive file. The selected package script runs in the isolated consumer.
Builder acceptance receives that installation through
`BUILDER_ACCEPTANCE_DEPENDENCY_ROOT`.

Successful checks print a consumer receipt. Failed runs retain their isolated
directories for inspection. The original consumer checkout is not switched into
a local dependency mode. Normal release commands retain their public-registry
acceptance requirements.

## Tooling checks

```sh
yarn test:local-packages
```

These tests use temporary registries without public uplinks. They cover restart
authentication, shutdown ownership, port conflicts, successive edited-source
snapshots, fresh consumer installs and changed archive rejection. They do not
launch Minecraft or a BDS instance.
