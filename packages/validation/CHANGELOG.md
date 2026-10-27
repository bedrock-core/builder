# @bedrock-core/builder-validation

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
