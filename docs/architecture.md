# Builder architecture

User documentation lives at https://bedrock-core.drav.dev/docs/builder. The configuration schema is `schemas/config.schema.json`; `src/config.ts` validates it and `src/plan.ts` resolves an ordered build without loading extensions.

## Execution and ownership

`src/run.ts` owns staging, invocation contexts, artifact ownership, validation and publication. Built-in processing lives in package-owned plugin entry points. Staged source remains available until consumers finish; export exclusions remove consumed authoring inputs from the published packs.

Pack identities come from configuration and manifests. Native dependency edges resolve against the complete project graph, including from targeted invocation contexts. A selected context must not change the graph's ownership or confuse external UUID dependencies with local pack IDs.

`src/regolith.ts` runs each Node script against one BP/RP mapping. Data sessions are keyed by authored source path. Explicit persistence coordinates data rollback with pack publication; `src/source-writes.ts` lets watch mode distinguish owned publication from authored edits.

## Cache invariants

Cache keys cover implementation, settings and observed inputs. Reuse restores emitted files and dependency tracking. Generated module and artifact names have one owner. Failed or canceled builds do not publish cache records or replace the previous successful export.

Compiled template reuse and template evaluation are separate decisions. UI caches store unlinked screen output; linking uses the complete current screen set. Final validation and publication still run on cache hits.

## Core asset publication

Native document declarations and rendering projections live in `@bedrock-core/bedrock-types`, shared by the bundler and server runtime. The package owns pinned schema inputs, native format corrections, declaration compilation and publication. Its build emits domain entry points and named parts into `dist`; cache records remain under `.bedrock-core/cache/schema-types`. Published consumers install the declarations without running Builder or downloading schemas.

The generator evaluates authored TS/JS templates and emits JSON. Templates import their document types from the published types package and tuple helpers from `@bedrock-core/builder-generator/templates`. Schema generation is independent of template execution.

When the installed `@bedrock-core/server-runtime` exports `assets/publish`, the bundler collects each script pack's block and item render definitions and its linked resource packs' geometry, texture atlases, texture bindings, carried textures and complete client entity documents. Native JSON roots and controller references are preserved. Block components and permutations retain schema-typed geometry, materials, transformations, item visuals and lighting; gameplay-only data is excluded. Item records link authored icon aliases and placed blocks. A generated setup module registers the immutable serialized dataset under the behavior pack's namespace before the authored script entry runs. Core prepares and publishes generated records with bounded work. Asset producers run before the bundler so their output participates in the collected dataset.

Producers register private presentation implementation files with `registerArtifact(id, file, { assetRegistry: false })`. `BuildContext.assetRegistryExclusions` exposes those exact files to the collector; the files remain in the exported packs. Public generated assets and authored assets participate by default, including files with the same basename as a private artifact. Registry exclusion does not infer ownership from a filename or entity identifier.

Texture records preserve variants and flipbooks. Terrain aliases retain their authored names; item aliases use `item:<alias>`. Entity texture references also receive exact-path aliases. Authored block definitions without explicit geometry identify `minecraft:geometry.full_block`; their format versions retain native UV semantics. Primitive geometry is supplied by vanilla packs or asset-map supplements and resolves through the geometry catalog. Resource-only texture overrides preserve an unspecified model. Geometry, expressions and controller definitions remain data for runtime lookup and later model composition. The dataset revision derives from its contents, and asset inputs participate in bundle reuse and watch dependencies.

The bundler setting `vanillaAssets: true` opts a profile into the shared vanilla catalog. Opted-in projects install `@bedrock-core/asset-maps`, a JSON-only build dependency. Builder validates its document hashes and composes its missing rendering definitions with the pinned Mojang samples. Upstream components take precedence, including matching permutations. The verified upstream archive is cached per project; supplied native packs or a verified metadata snapshot support offline builds. The default is false, so authored addon assets publish without loading or downloading vanilla inputs. Dynamic world queries do not provide a reliable build-time usage signal, so vanilla inclusion is explicit.

For opted-in profiles, the bundler invokes the generator in Node and adds an exact catalog reference to the pack's imports. Its implementation and data are tracked as build inputs; Node-only generator code stays out of runtime bundles. A catalog for a different Minecraft target is reported as unavailable while authored asset publication continues. Generated atlas files are staged only into a linked resource pack.

## Verification

Run `yarn check` for lint, types and unit tests. `yarn test:cli` checks generated projects. `yarn pack-release` and `yarn test:packages` verify installed release APIs, workers and declarations. Registry-only starter and native Minecraft checks are distinct acceptance results.

`releasing.md` describes package preparation and publication. Internal cache measurements use `scripts/benchmark-ui.ts` with isolated fixture output.
