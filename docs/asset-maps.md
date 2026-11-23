# Asset Maps

`@bedrock-core/asset-maps` supplies missing vanilla rendering definitions as
native Bedrock behavior and resource pack JSON. Builder composes the supplements
with the matching Mojang samples when `bundler.vanillaAssets` is enabled.
Behavior files provide missing block and item rendering components. Resource
files provide geometry and texture aliases. Existing Mojang definitions take
precedence over supplements.

## Package layout

- `packages/asset-maps/src` contains native Node TypeScript entry points and
  source readers, conversion, and Bedrock document export.
- `data` contains source pins, native state captures, reviewed relationships,
  renderer profiles, and license notices.
- `definitions` contains authored Bedrock supplements.
- `dist` contains generated pack JSON, licenses, `source-lock.json`,
  `coverage.json` and an `index.json` with per-document hashes.

`releases.json` ties each npm version to the exact Mojang Bedrock Samples tag
and full-archive hash. The version drops the `v1.` prefix from the tag. For
example, `v1.26.60.30-preview` publishes as `26.60.30-preview`. Reviewed inputs
for added releases live under `data/releases/<version>`.

The npm package contains the generated distribution and its source notices.
Generation caches hash-verified upstream files and Java extraction under
`packages/asset-maps/.bedrock-core/cache/asset-maps/inputs`. Intermediate
conversions stay in memory. Coverage captures fallbacks, unresolved relationships,
and render approximations. A reference audit checks the asset data graph.

## Maintenance

Use Builder's pinned Node and Yarn versions. Set `JAVA_HOME` to the JDK
matching the pinned Java client, currently 25 for Java 26.3.

Run commands from the Builder checkout.

```sh
corepack yarn prepare:assets
corepack yarn workspace @bedrock-core/asset-maps build --version 26.60.30-preview --offline
corepack yarn workspace @bedrock-core/asset-maps audit --version 26.60.30-preview --offline
corepack yarn workspace @bedrock-core/asset-maps test
```

- `build` generates the workspace version in `dist`. `--version <version>`
  selects a reviewed release and writes to `.bedrock-core/releases/<version>/dist`.
  `--pretty` and `--compact` select JSON formatting. `--check` runs fresh Java
  extraction and compares the generated files with the selected distribution.
  `--states <file>` supplies a native state inventory for the pinned
  version. `--force-java` refreshes the extraction cache. `--offline` uses the
  verified local inputs.
- `audit` checks references and redundant supplements against the selected
  native archive. Use `--version <version>` for a release build and
  `--output <file>` to save its report.
- `pin --bedrock <version> --channel <stable|preview>` proposes compatible
  upstream pins. `--java` and `--mappings` constrain the version pair.
  `--apply --states <file>` audits and records the release inputs. Java client
  changes require reviewing the extractor and renderer profiles.
- `update --channel <stable|preview>` discovers release and preview changes.
  `--tag <samples-tag>` selects a specific release. Add the matching native
  state capture to `data/releases/<version>/native-states.json` for candidate
  generation. Place reviewed renderer, binding or texture rule changes in the
  same folder. `--write` records a candidate that passes the audit.
- `diff <version> <version>` writes a file summary and patch between reviewed
  distributions. `pack:release <version>` builds, audits, and verifies the
  selected JSON-only npm archive.

When Renovate updates Minecraft sources, the **Update Minecraft packages**
workflow checks both Asset Maps channels and captures states from matching BDS
builds. Asset Maps pins go into the shared Minecraft update PR. The workflow
attaches coverage and distribution diffs, reports pending inputs, and marks the
PR as a draft when coverage regresses. Use **Publish Minecraft packages** to
publish the reviewed version. Stable releases advance `latest`, previews advance
`preview`, and older publications receive a version-specific npm tag.

See [source provenance](../packages/asset-maps/SOURCES.md) for mapping selection,
source inputs, and notices.
