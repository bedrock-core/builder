# @bedrock-core/builder-i18n

## 0.2.0

### Minor Changes

- 930de95: Own addon namespaces and metadata in authored manifests, resolve native addon dependencies, prepare pack artwork and client display aliases, and expose an authored-manifest editor schema.
  
  Generate typed clients from public addon package exports and bind provider APIs in their owning behavior packs without evaluating or bundling provider implementations in consumers.
- 930de95: Require Node.js 26.13.0 or newer for Builder packages, the CLI, and new projects.
  
  Use TypeScript 7.1 for Builder's source analysis, declaration emission, and release compilation. New script and full projects use TypeScript 7.1 for typechecking and retain a compatible compiler for ESLint.

### Patch Changes

- 930de95: Discover authored screens in behavior-pack `ui/` directories, reserve their helpers from content generation and omit UI sources from exported packs. Continue compiling screens under `scripts/` through the same pipeline.
  
  Scaffold UI sources directly in `packs/BP/ui/` with matching runtime imports and TypeScript includes. Match the starter's exact UI dependency to its shared render-pack requirement.
  
  Keep the shared translation instance in `packs/BP/i18n/index.ts` and exclude runtime index modules from locale compilation and detection.
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
  - @bedrock-core/builder-plugin@0.2.0
  - @bedrock-core/builder-bundler@0.2.0

## 0.1.0

### Minor Changes

- 2a9f1e8: Use `pack.name`, `pack.description` and `pack.creator` for localized pack display text, generated metadata defaults and starter templates.
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
- Updated dependencies [59ca6b9]
- Updated dependencies [9ff3921]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [9dfba7a]
  - @bedrock-core/builder-bundler@0.1.0
  - @bedrock-core/builder-plugin@0.1.0
