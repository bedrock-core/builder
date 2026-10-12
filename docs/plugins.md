# @bedrock-core plugins

Built-in transformations and external modules use one Node plugin contract. A
plugin owns its input detection, processing, helpers, workers and cache keys. The
builder supplies configuration, ordering, staging, artifact ownership, cache
services, final validation and export.

## Module format

Export `run(context, settings)` from the configured module. An optional
`detect(context, settings)` returns `{ needed, reason }` without evaluating resource
modules. Built-in profile stages use detection in `auto` mode. External steps run
unconditionally unless the step selects `"mode": "auto"`; a module without a
detector runs in either mode. Standalone Node script definitions support explicit
execution rather than module detection.

```json
{
  "plugins": {
    "widgets": { "module": "@example/widgets/builder" }
  },
  "profiles": {
    "default": {
      "steps": [{ "plugin": "widgets", "before": "bundler", "mode": "auto" }],
      "export": { "BP": "./dist/BP", "RP": "./dist/RP" }
    }
  }
}
```

These fields belong under `bedrockCore`. Profile stages invoke the bundled
`@bedrock-core/builder-{manifest,generator,guides,i18n,ui,bundler}/plugin`
entrypoints in their default order. Those entrypoints can also be configured as
external module steps. Disable the corresponding default stage to avoid running
the same processing twice. Existing stage settings and before/after boundaries
remain available.

Use `BuildContext` from `@bedrock-core/builder-plugin` for shared services. Write
pack changes under `context.packs` and intermediates under `context.generatedDir`.
Register observed authored inputs with `registerDependency`. Register emitted
files with `registerArtifact`; `importAs` makes a generated module available to
later compiler plugins. Generated names and artifact IDs have one owner.

Pass `{ importAs, pack: packId }` to register a pack-owned module. Within that pack,
the unqualified import resolves to its own artifact. Explicit consumers use
`importAs/<packId>`; `generatedImportsFor(packId)` exposes the effective registry.
Two packs can provide the same unqualified import without sharing runtime data.

Built-ins may export `inputDirectories(context, settings)` to declare non-template
source directories. This metadata is read before generation without evaluating the
source modules. Call `excludeFromExport(path)` to omit consumed source inputs only
after all downstream steps finish. Both services keep sources in their owning packs.

The host's `reuse` service accepts invocation-scoped IDs, deterministic keys and
file dependencies. Cache keys must include the plugin implementation and relevant
settings. Cacheable values contain only JSON data and emitted files remain within
the temporary workspace. Hits retain dependency tracking and restore file output.

## Pack ownership

`targets` accepts legacy behavior/resource shorthands or an object with `packs` and
`modules`. IDs intersect with any matching module type; a data+script pack is selected
once. Targeted module invocations default to one pack each; `scope: "project"` supplies
the matching set in one invocation. Untargeted plugins run once for the project.

`context.inspectPacks()` resolves the full profile-selected pack graph even before the
manifest stage writes output. `context.inspectPack(id)` returns a descriptor from that
graph. Descriptors distinguish local pack, external UUID and scripting API requirements.
Reciprocal pack requirements do not reorder plugin execution. `context.project` exposes
shared display/package metadata without build configuration.

Use `resolveFeaturePacks(context, { owner, resourcePack })` from
`@bedrock-core/builder-plugin` for features with separate runtime and resource outputs.
The owner defaults to the sole script pack or sole pack. Resources must be a direct local
dependency of that owner, or the resource owner itself. Ambiguity is an error; explicit
destinations are validated. Pass `false` as the third argument for runtime-only output.
Use returned descriptors to register cross-pack artifacts rather than assuming that the
destination is present in a targeted invocation's `context.packs` map.

## Bundling contributions

Content processing can generate pack files before bundling. A feature that also
needs module resolution or source transformation registers an extension:

```ts
context.registerBundleExtension({
  id: 'example:widgets',
  version: implementationFingerprint,
  plugins: [widgetContentLoader],
});
```

`plugins` uses esbuild's plugin API and runs before the standard import resolver.
Extensions may supply `jsxImportSource`, `resolveFromProject` import prefixes and
specific pack IDs. Different JSX runtime selections for one pack fail. Extension
IDs must be unique; targeted invocations default to their current pack.

Custom compiler plugins disable bundle reuse by default. Set `cache: true` only
when `version` covers implementation/settings changes and every input is listed
in `inputs` or returned by an esbuild hook through `watchFiles`. Directory watches
and virtual modules without observable files conservatively disable reuse.

The UI plugin owns screen processing and registers its JSX transformation and
project import preferences through this same interface. The bundler consumes
extensions without importing feature-specific implementations.

## Features with a runtime registry

One feature package can provide separate builder and Minecraft runtime
entrypoints. For example, `@example/widgets/builder` processes content and publishes
`@bedrock-core/generated/widgets`; `@example/widgets/runtime` exposes a declaration
that consumes those definitions and installs its registry into a Core slot.

The builder entrypoint runs in Node. The runtime entrypoint is bundled from addon
imports and executes in Minecraft. Shared data formats may live in the same
package. Each part imports its own environment's dependencies.

Runtime installation uses the existing `Declaration<T>` contract and namespaced
`RuntimeSlots`: `install(core)` constructs the registry and calls `core.fill`,
while the owning package reads it through `core.slot`. Addons select the declaration
through `core.register`. Building a feature does not install its runtime registry.
A plugin may supply build processing, runtime behavior, or both.

Export the entrypoints callers load. Helpers and workers stay package-local;
cross-package imports use explicit public contracts.
