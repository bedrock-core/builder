# @bedrock-core/builder-ui

## 0.2.1

### Patch Changes

- 3098e57: Register container text positions even when the screen has no appearance variants so runtime inventory allocation matches the compiled layout.
  
  Classify runtime text dependencies from JSX expressions and Core text factory calls in both compilation and runtime bundles, while retaining baked literal captions.

## 0.2.0

### Minor Changes

- 5116709: Compile experimental Ore screens, register shared scene data and package version-matched client assets and input resources.

### Patch Changes

- 25c298b: Link runtimes that carry live container text in item names while retaining character-table translations when provided. Accept portable snapshots with compiler-detected text positions.

## 0.1.0

### Minor Changes

- 9ff3921: Compile guides from each owner pack, with separate generated manifests, typed imports
  and language contributions routed to declared local resource dependencies. Reserve
  guide inputs from template generation and omit them from published packs. Preserve
  independent language sections and reject conflicting keys in shared destinations.
  Keep CLI guide samples inside the behavior pack and resolve builder guide paths
  relative to their owner. Standalone compilation resolves paths from the supplied root.
- 09203ce: Resolve profile-selected pack graphs and module selectors, route feature output through
  declared local resource dependencies, and generate shared project metadata for manifests
  and authored content. Native manifests inherit project defaults and preserve
  authored pack and module identities. Client translation output requires a
  linked local resource pack; runtime-only translations select `client: false`.
  
  Discover locales inside each owner pack, reserve them from template generation and
  omit build sources from publication after consumers finish. Generate distinct per-pack
  runtime imports and declarations, and compose independent language sections in shared
  resource destinations with conflict diagnostics.
- 09203ce: Expose package-owned `./plugin` entrypoints through the shared build context and
  plugin contracts. Declare public export paths explicitly and keep implementation
  helpers private. Bundler extensions contribute compiler plugins, virtual modules,
  resolution settings and tracked inputs with conservative cache reuse. Standalone
  packages load using their own declared dependencies.
- 09203ce: Compile navigation helpers against the shared UI runtime and emit screen
  descriptors with host kinds and validated public parameter contracts. Include
  native host keys in generated discovery declarations and retain components that
  rebuild from parameter inputs. UI source buffers can be evaluated without changing
  authored files and disable compilation reuse.

### Patch Changes

- 878fe82: Omit compiled pack-local UI TypeScript sources and helpers from exported packs.
- 878fe82: Isolate UI host probes across screen roots while retaining component state only during liveness analysis.
- 878fe82: Share navigation runtime extensions across compiled screen modules.
- 2a9f1e8: Transfer portable UI compilation results directly between workers, excluding source trees and supporting large linked screen collections without a single JSON transport string.
- Updated dependencies [59ca6b9]
- Updated dependencies [9ff3921]
- Updated dependencies [878fe82]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [583575b]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [9dfba7a]
  - @bedrock-core/builder-bundler@0.1.0
  - @bedrock-core/builder-plugin@0.1.0
  - @bedrock-core/builder-manifest@0.1.0
