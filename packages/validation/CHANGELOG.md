# @bedrock-core/builder-validation

## 0.2.0

### Minor Changes

- 930de95: Require script manifest entries to name their authored source files and publish TypeScript entries as JavaScript paths. Report missing sources and conflicting outputs in build diagnostics.
  
  Configure content schema validation as strict, warn, or skip while retaining manifest and JSON syntax checks. Validate sound definitions with bare paths and named sound objects.
- 930de95: Require Node.js 26.13.0 or newer for Builder packages, the CLI, and new projects.
  
  Use TypeScript 7.1 for Builder's source analysis, declaration emission, and release compilation. New script and full projects use TypeScript 7.1 for typechecking and retain a compatible compiler for ESLint.

## 0.1.1

### Patch Changes

- aed8e9b: Validate infinite spell effects, mixed client render-controller entries and numeric geometry vectors against the pinned schema catalog.

## 0.1.0

### Minor Changes

- 09203ce: Expose package-owned `./plugin` entrypoints through the shared build context and
  plugin contracts. Declare public export paths explicitly and keep implementation
  helpers private. Bundler extensions contribute compiler plugins, virtual modules,
  resolution settings and tracked inputs with conservative cache reuse. Standalone
  packages load using their own declared dependencies.

### Patch Changes

- 59ca6b9: Accept single terrain texture paths alongside path arrays when validating with the pinned Mojang schema catalog.
