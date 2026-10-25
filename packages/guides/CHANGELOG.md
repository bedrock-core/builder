# @bedrock-core/builder-guides

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

### Patch Changes

- 878fe82: Generate resident client navigation for guide entries, with audience-specific page selections and fixed caller-return variants. Keep generated screen modules as build inputs and omit them from exported packs.
- Updated dependencies [9ff3921]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
  - @bedrock-core/builder-plugin@0.1.0
