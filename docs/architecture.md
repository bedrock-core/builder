# Builder architecture

User documentation lives at https://bedrock-core.drav.dev/docs/builder. The configuration schema is `schemas/config.schema.json`; `src/config.ts` validates it and `src/plan.ts` resolves an ordered build without loading extensions.

## Execution and ownership

`src/run.ts` owns staging, invocation contexts, artifact ownership, validation and publication. Built-in processing lives in package-owned plugin entry points. Staged source remains available until consumers finish; export exclusions remove consumed authoring inputs from the published packs.

Pack identities come from configuration and manifests. Native dependency edges resolve against the complete project graph, including from targeted invocation contexts. A selected context must not change the graph's ownership or confuse external UUID dependencies with local pack IDs.

`src/regolith.ts` runs each Node script against one BP/RP mapping. Data sessions are keyed by authored source path. Explicit persistence coordinates data rollback with pack publication; `src/source-writes.ts` lets watch mode distinguish owned publication from authored edits.

## Cache invariants

Cache keys cover implementation, settings and observed inputs. Reuse restores emitted files and dependency tracking. Generated module and artifact names have one owner. Failed or canceled builds do not publish cache records or replace the previous successful export.

Compiled template reuse and template evaluation are separate decisions. UI caches store unlinked screen output; linking uses the complete current screen set. Final validation and publication still run on cache hits.

## Verification

Run `yarn check` for lint, types and unit tests. `yarn test:cli` checks generated projects. `yarn pack-release` and `yarn test:packages` verify installed release APIs, workers and declarations. Registry-only starter and native Minecraft checks are distinct acceptance results.

`releasing.md` describes package preparation and publication. Internal cache measurements use `scripts/benchmark-ui.ts` with isolated fixture output.
