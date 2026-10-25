# @bedrock-core/builder-manifest

## 0.1.0

### Minor Changes

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

- 878fe82: Emit unambiguous localized manifest names and descriptions for linked behavior and resource packs, preserve pack-specific display text, and register fallback language catalogs.
- 583575b: Ignore absent export exclusions beneath regular files, preserving imported JSON assets during UI builds. Recognize local migration wrappers by canonical paths within the trusted checkout. Canonicalize temporary workspaces so artifact ownership checks accept Windows short paths and filesystem aliases. Resolve manifest inheritance within the canonical project boundary when the authored root uses a filesystem alias.
- 59ca6b9: Fill missing manifest license and homepage metadata from the project and record the bedrock-core generator version while preserving authored metadata.
- Updated dependencies [9ff3921]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
  - @bedrock-core/builder-plugin@0.1.0
