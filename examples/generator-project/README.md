# @bedrock-core generator example

Run `yarn build examples/generator-project/config.json` from the builder repository.
The manifest selects `packs/gameplay/scripts/main.ts` through its `scripts/main.js` entry.

`packs/gameplay/loot_tables/drops.ts` emits `apple.json` and `bread.json`. Both the template
and the runtime script import `shared/drops.json`. `shared/loot.ts` is an ordinary typed
helper outside the pack; only declared packs are exported. The outputs appear under
`dist/gameplay`, with consumed template sources removed from the staged export.
The template default-exports `[nameFn, dataFn, items] satisfies Many<Drop, LootTable>`.
`packs/gameplay/entities/training_dummy.entity.ts` exports a plain object satisfying `Entity`
and produces `training_dummy.entity.json`. Both forms use ordinary imports and require no
runtime helper call.

The build prepares global document types from Mojang's schema catalog under
`.bedrock-core/generated/mc`. The project's tsconfig includes these declarations. Run
`yarn exec tsc --project examples/generator-project/tsconfig.json` from the builder repository
after building to check template types. Pin `generator.schemaVersion` in the stage settings
when builds need an exact schema version.

The loot structure follows [Microsoft's loot table guide](https://learn.microsoft.com/en-us/minecraft/creator/documents/createloottable).
The tables are available for other content to reference. This example does not attach them
to an entity or override vanilla tables. Minecraft content validation and in-game acceptance
are separate checks.
