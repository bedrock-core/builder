# @bedrock-core/builder-plugin

## 0.1.0

### Minor Changes

- 9ff3921: Require an explicit build namespace and keep runtime creator, pack and version
  declarations in each script pack's registration. The generated project module
  provides shared display and package metadata for authored content.
- 59ca6b9: Select native plugin owners from declared manifest module requirements, with shared pack restrictions and named direct-dependency overrides. Reject ambiguous relationships and conflicting edits to shared pack outputs.
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

- 59ca6b9: Fill missing manifest license and homepage metadata from the project and record the bedrock-core generator version while preserving authored metadata.
