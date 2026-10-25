# @bedrock-core/builder-bundler

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
