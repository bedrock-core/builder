# @bedrock-core/builder-bundler

## 0.2.0

### Minor Changes

- 930de95: Generate portable checked wrappers for reusable API declaration factories and support recursive plain JSON contracts.
- 930de95: Own addon namespaces and metadata in authored manifests, resolve native addon dependencies, prepare pack artwork and client display aliases, and expose an authored-manifest editor schema.
  
  Generate typed clients from public addon package exports and bind provider APIs in their owning behavior packs without evaluating or bundling provider implementations in consumers.
- 930de95: Require script manifest entries to name their authored source files and publish TypeScript entries as JavaScript paths. Report missing sources and conflicting outputs in build diagnostics.
  
  Configure content schema validation as strict, warn, or skip while retaining manifest and JSON syntax checks. Validate sound definitions with bare paths and named sound objects.
- 930de95: Generate native component, inventory and value contracts from public SDK types. Trace eligible provider and dependency lookups with native TypeScript analysis and preserve tracing requirements in portable API packages.
- 930de95: Require Node.js 26.13.0 or newer for Builder packages, the CLI, and new projects.
  
  Use TypeScript 7.1 for Builder's source analysis, declaration emission, and release compilation. New script and full projects use TypeScript 7.1 for typechecking and retain a compatible compiler for ESLint.
- 930de95: Generate API object metadata for explicit registration and project writable sources into read-only consumer declarations.
- 930de95: Recognize standard JavaScript collections, structured built-ins and big integers in checked addon API signatures. Generate nested native-reference, callback and value-class adapters for map keys, collection values, state and signals while keeping provider implementations outside consumer bundles.

### Patch Changes

- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
  - @bedrock-core/builder-plugin@0.2.0
  - @bedrock-core/builder-manifest@0.2.0

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

- 59ca6b9: Bundle JavaScript helper packages such as `@minecraft/vanilla-data`, `@minecraft/math` and `@minecraft/common` into script output. Retain native Minecraft server API imports for the engine.
- 9dfba7a: Keep bundled TypeScript artifacts available through artifact validation and omit their source files from exported packs.
- Updated dependencies [9ff3921]
- Updated dependencies [878fe82]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [583575b]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
  - @bedrock-core/builder-plugin@0.1.0
  - @bedrock-core/builder-manifest@0.1.0
