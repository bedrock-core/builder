# Builder architecture

User documentation lives at https://bedrock-core.drav.dev/docs/builder. The configuration schema is `schemas/config.schema.json`; `src/config.ts` validates it and `src/plan.ts` resolves an ordered build without loading extensions.

## Execution and ownership

`src/run.ts` owns staging, invocation contexts, artifact ownership, validation and publication. Built-in processing lives in package-owned plugin entry points. Staged source remains available until consumers finish; export exclusions remove consumed authoring inputs from the published packs.

Pack identities come from configuration and manifests. Native dependency edges resolve against the complete project graph, including from targeted invocation contexts. A selected context must not change the graph's ownership or confuse external UUID dependencies with local pack IDs.

`src/regolith.ts` runs each Node script against one BP/RP mapping. Data sessions are keyed by authored source path. Explicit persistence coordinates data rollback with pack publication; `src/source-writes.ts` lets watch mode distinguish owned publication from authored edits.

## Cache invariants

Cache keys cover implementation, settings and observed inputs. Reuse restores emitted files and dependency tracking. Generated module and artifact names have one owner. Failed or canceled builds do not publish cache records or replace the previous successful export.

Compiled template reuse and template evaluation are separate decisions. UI caches store unlinked screen output; linking uses the complete current screen set. Final validation and publication still run on cache hits.

## Experimental Ore assets

The UI stage prepares client assets when its linked screen set contains `<Experimental_OreUI>`. `packages/ui-compiler/src/ore-assets.ts` selects a complete Windows client matching the project's `targetVersion`, preserves the client's vanilla entry/root and bundle references, and adds the standalone adapter. Builds without Ore screens do not inspect client installations.

Optional UI-stage settings select an explicit client and fallback resource packs:

```json
{
  "experimentalOre": {
    "clientRoot": "C:/Games/Minecraft/Content",
    "resourceRoots": ["../shared/packs/RP"]
  }
}
```

Paths resolve from the project. The selected output RP has priority; fallback roots are searched in listed order for only the referenced PNGs and their sidecars. PNG dimensions and logical `base_size`/`nineslice_size` borders are linked into each Ore layout. The stage copies the selected client's Mojangles and Minecraft Ten fonts and records client version and entry hash in `bedrock-core/experimental-ore.json`. Installed assets and authored roots are read-only. An authored `hbui/gameplay.html`, missing assets, release mismatch or differing automatic entry candidates fails the build.

Selected bundles, fonts, PNGs and present/missing sidecars are tracked as inputs. Asset linking runs after screen-cache reuse, and final files are registered once after preparation. Ore assets stay outside `_ui_defs.json`. Pack versioning remains owned by the manifests and release process; preparation does not certify native compatibility.

The texture pass also links checked toggle faces, slider progress/thumb faces and dropdown popup/option faces. Composed `<Trans>` keys from Ore screens are merged into the resource pack's language files through the same output pass as other compiled screens.

Layouts with live fields also emit a pack-local copy of the selected gameplay bundle. `ore-input.ts` locates one native `BaseTextField` callback/ref through its syntax tree and adds an effect registering that pair with the standalone adapter. Unknown or ambiguous component shapes fail the build. The dedicated DOM listener accepts only session-marked mailbox packets and is removed on unmount; ordinary native inputs retain their existing behavior. The asset report records the bridge schema and both bundle hashes. Installed client files are never modified.

## Verification

Run `yarn check` for lint, types and unit tests. `yarn test:cli` checks generated projects. `yarn pack-release` and `yarn test:packages` verify installed release APIs, workers and declarations. Registry-only starter and native Minecraft checks are distinct acceptance results.

`releasing.md` describes package preparation and publication. Internal cache measurements use `scripts/benchmark-ui.ts` with isolated fixture output.
