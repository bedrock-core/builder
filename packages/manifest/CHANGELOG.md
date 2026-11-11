# @bedrock-core/builder-manifest

## 0.2.0

### Minor Changes

- 930de95: Own addon namespaces and metadata in authored manifests, resolve native addon dependencies, prepare pack artwork and client display aliases, and expose an authored-manifest editor schema.
  
  Generate typed clients from public addon package exports and bind provider APIs in their owning behavior packs without evaluating or bundling provider implementations in consumers.
- 930de95: Require script manifest entries to name their authored source files and publish TypeScript entries as JavaScript paths. Report missing sources and conflicting outputs in build diagnostics.
  
  Configure content schema validation as strict, warn, or skip while retaining manifest and JSON syntax checks. Validate sound definitions with bare paths and named sound objects.
- 930de95: Require Node.js 26.13.0 or newer for Builder packages, the CLI, and new projects.
  
  Use TypeScript 7.1 for Builder's source analysis, declaration emission, and release compilation. New script and full projects use TypeScript 7.1 for typechecking and retain a compatible compiler for ESLint.

### Patch Changes

- 930de95: Generate native component, inventory and value contracts from public SDK types. Trace eligible provider and dependency lookups with native TypeScript analysis and preserve tracing requirements in portable API packages.
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
  - @bedrock-core/builder-plugin@0.2.0

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
