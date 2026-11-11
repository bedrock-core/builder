# @bedrock-core/builder

## 0.2.0

### Minor Changes

- 930de95: Add producer-owned artifact finalization after plugin hooks and source exclusions, before final pack validation.
  
  Refresh UI metadata hashes against final exported files and preserve stable script-entry provenance for shaped application screens.
- 930de95: Generate portable checked wrappers for reusable API declaration factories and support recursive plain JSON contracts.
- 930de95: Own addon namespaces and metadata in authored manifests, resolve native addon dependencies, prepare pack artwork and client display aliases, and expose an authored-manifest editor schema.
  
  Generate typed clients from public addon package exports and bind provider APIs in their owning behavior packs without evaluating or bundling provider implementations in consumers.
- 930de95: Require script manifest entries to name their authored source files and publish TypeScript entries as JavaScript paths. Report missing sources and conflicting outputs in build diagnostics.
  
  Configure content schema validation as strict, warn, or skip while retaining manifest and JSON syntax checks. Validate sound definitions with bare paths and named sound objects.
- 930de95: Generate native component, inventory and value contracts from public SDK types. Trace eligible provider and dependency lookups with native TypeScript analysis and preserve tracing requirements in portable API packages.
- 930de95: Require Node.js 26.13.0 or newer for Builder packages, the CLI, and new projects.
  
  Use TypeScript 7.1 for Builder's source analysis, declaration emission, and release compilation. New script and full projects use TypeScript 7.1 for typechecking and retain a compatible compiler for ESLint.
- 930de95: Generate API object metadata for explicit registration and project writable sources into read-only consumer declarations.

### Patch Changes

- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
- Updated dependencies [930de95]
  - @bedrock-core/builder-ui@0.3.0
  - @bedrock-core/builder-i18n@0.2.0
  - @bedrock-core/builder-plugin@0.2.0
  - @bedrock-core/builder-bundler@0.2.0
  - @bedrock-core/builder-manifest@0.2.0
  - @bedrock-core/builder-guides@0.2.0
  - @bedrock-core/builder-validation@0.2.0
  - @bedrock-core/builder-generator@0.2.0

## 0.1.2

### Patch Changes

- 3098e57: Register container text positions even when the screen has no appearance variants so runtime inventory allocation matches the compiled layout.
  
  Classify runtime text dependencies from JSX expressions and Core text factory calls in both compilation and runtime bundles, while retaining baked literal captions.
- Updated dependencies [3098e57]
  - @bedrock-core/builder-ui@0.2.1

## 0.1.1

### Patch Changes

- Version Builder stage and plugin packages independently with Changesets and preserve dependency-owned versions in release metadata.
- Updated dependencies [aed8e9b]
- Updated dependencies [5116709]
- Updated dependencies [de16949]
- Updated dependencies [25c298b]
  - @bedrock-core/builder-validation@0.1.1
  - @bedrock-core/builder-ui@0.2.0
  - @bedrock-core/builder-guides@0.1.1

## 0.1.0

### Minor Changes

- c0ffcd9: Exclude configured project paths from staging and watch mode, and reuse validated cache values without an additional JSON round trip.
- 09203ce: Scaffold full, plain script and resource-only projects with `bc-builder` commands,
  named packs and build, watch and GameTest profiles. Define display metadata and
  the build namespace in configuration, inherit manifest defaults and declare runtime
  registration explicitly in each script pack. Full starters keep
  translations and guides in the owning behavior pack and link resource output through native
  dependencies. Pin the UI toolkit and its render-pack dependency together, including
  the modules resource-pack description in both behavior manifests.
- 9ff3921: Require an explicit build namespace and keep runtime creator, pack and version
  declarations in each script pack's registration. The generated project module
  provides shared display and package metadata for authored content.
- 59ca6b9: Select native plugin owners from declared manifest module requirements, with shared pack restrictions and named direct-dependency overrides. Reject ambiguous relationships and conflicting edits to shared pack outputs.
- 59ca6b9: Run Node scripts against explicit BP/RP folder mappings, with independent data workspaces and optional successful-build data persistence.
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

- 5922b1b: Expose the builder executable as `bc-builder` and use it in generated project scripts.
- 583575b: Ignore absent export exclusions beneath regular files, preserving imported JSON assets during UI builds. Recognize local migration wrappers by canonical paths within the trusted checkout. Canonicalize temporary workspaces so artifact ownership checks accept Windows short paths and filesystem aliases. Resolve manifest inheritance within the canonical project boundary when the authored root uses a filesystem alias.
- 59ca6b9: Fill missing manifest license and homepage metadata from the project and record the bedrock-core generator version while preserving authored metadata.
- 9dfba7a: Keep bundled TypeScript artifacts available through artifact validation and omit their source files from exported packs.
- Updated dependencies [59ca6b9]
- Updated dependencies [878fe82]
- Updated dependencies [9ff3921]
- Updated dependencies [59ca6b9]
- Updated dependencies [878fe82]
- Updated dependencies [878fe82]
- Updated dependencies [59ca6b9]
- Updated dependencies [878fe82]
- Updated dependencies [2a9f1e8]
- Updated dependencies [9ff3921]
- Updated dependencies [09203ce]
- Updated dependencies [583575b]
- Updated dependencies [59ca6b9]
- Updated dependencies [878fe82]
- Updated dependencies [09203ce]
- Updated dependencies [59ca6b9]
- Updated dependencies [09203ce]
- Updated dependencies [2a9f1e8]
- Updated dependencies [9dfba7a]
  - @bedrock-core/builder-bundler@0.1.0
  - @bedrock-core/builder-ui@0.1.0
  - @bedrock-core/builder-plugin@0.1.0
  - @bedrock-core/builder-generator@0.1.0
  - @bedrock-core/builder-i18n@0.1.0
  - @bedrock-core/builder-manifest@0.1.0
  - @bedrock-core/builder-guides@0.1.0
  - @bedrock-core/builder-validation@0.1.0
