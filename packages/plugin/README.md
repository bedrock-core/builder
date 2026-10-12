# @bedrock-core/builder-plugin

Shared contracts and helpers for built-in and external Node build plugins. Plugins
export `run(context, settings)` and may export `detect(context, settings)` for
automatic participation. The host supplies the same staged workspace, artifact,
dependency, cache and bundler-extension services to both kinds of plugin.

```ts
import type { BuildContext, BuildDetection } from '@bedrock-core/builder-plugin';

export function detect(context: BuildContext): BuildDetection {
  return { needed: Object.keys(context.packs).length > 0, reason: 'configured packs' };
}

export async function run(context: BuildContext) {
  context.signal?.throwIfAborted();
  // Process files under context.stagedRoot or context.packs.
}
```

The package exports `BuildPlugin`, `BuildContext`, `BuildDetection`, `BuildStep`,
`BuildStepResult`, `PackInfo`, `Artifact`, `BundleExtension`, cache contracts and
`JsonFormatting`. `generatedAliases` resolves registered import names and artifact
overrides. `hasFiles` checks glob-selected files without evaluating modules.
`fingerprint` hashes explicit implementation files; package-local URLs work in
both TypeScript checkouts and JavaScript releases.

`registerArtifact(id, file, { importAs, pack })` scopes the unqualified import to one
configured pack and exposes `importAs/<packId>` for explicit consumers. Separate packs
can own the same unqualified import; conflicting producers in one scope fail.
`generatedImportsFor(packId)` and `generatedAliases(context, overrides, packId)` select
the corresponding module, while unscoped artifacts remain shared.

Built-ins can declare `inputDirectories(context, settings)` without evaluating content.
The host reserves those source directories before template discovery. The generator
protects them from JSON generation. `excludeFromExport(path)` retains a pack input for
downstream consumers and removes it before final validation and publication; pack roots
and paths outside packs are rejected.

`inspectPacks` reads a complete pack graph; `describePack` and `resolvePackGraph` work
with already resolved manifests. `selectPacks` intersects explicit IDs with any matching
module type, selecting a data+script pack once. `resolvePackOwner` and
`resolveResourcePack` reject ambiguous ownership and require a direct local resource
dependency (or a resource owner itself). Reciprocal requirements are permitted.

In the builder, `context.inspectPacks()` and `context.allPacks` expose the full graph
even when `context.packs` contains a targeted subset. `resolveFeaturePacks` supplies
validated owner/destination descriptors for cross-pack processing. Shared resolved
metadata is available as `context.project`; these helpers need no Core runtime.

`context.reuse(id, options)` scopes cache IDs to the current invocation. Plugins
provide implementation/settings keys and observed file inputs. Cache hits restore
declared files into fresh staging and retain watch dependencies. Values must be
JSON serializable; output files must stay inside staging roots. The host controls
cache boundaries and persistence. Profile `cache: false` forces execution.

`context.registerBundleExtension` accepts esbuild plugins, optional JSX runtime
selection and import prefixes resolved from the authored project first. Register
extensions before bundling. IDs are unique for the build; include pack IDs when a
plugin runs once per pack. Targeted invocations default extensions to their current
pack. Extensions with custom compiler plugins rebuild by default. Opt into reuse
with `cache: true` only when the version includes implementation/settings changes
and all inputs are declared or returned through `watchFiles`. Hooks using
`watchDirs` conservatively disable reuse.

Plugins execute trusted Node code. Cancellation and failure prevent pack export;
staged paths expire when the host finishes. This package has no Minecraft runtime
dependency. See [plugin authoring](../../docs/plugins.md) for feature ownership and
runtime entrypoints.
