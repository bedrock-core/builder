# @bedrock-core configuration migration

Run the migration from the builder checkout with Yarn and Node 22.18 or later:

```sh
yarn migrate path/to/config.json
```

Preview mode prints a proposed configuration and diagnostics without modifying files.
`--json` prints an object containing `config`, `diagnostics` and `ready`. Errors return
exit code 1 and prevent all writes. Warnings identify checks required before adopting
the generated configuration; readiness describes configuration conversion, not runtime parity.
The command reads JSON, manifests and file paths. It never loads project modules, evaluates
expressions, runs shell commands or downloads filters.

## Supported conversion

| Input | Result |
| --- | --- |
| Regolith `formatVersion` 1.4.0 or 1.8.0 | `bedrockCore.formatVersion` 1.0.0; source `regolith` section retained |
| Project metadata and other tool sections | Preserved; singular `author` becomes `authors` when no authors list exists |
| Profile references | Flattened with cycle detection; repeated or reordered built-in stages require manual conversion |
| Verified `@bedrock-core` manifest, generator, i18n, UI compiler and bundler filters | Built-in stages with supported settings; absent and disabled stages stay disabled |
| `core` | Shared settings merged into stages; generator opt-in preserved |
| `watchPaths` | Copied to each selected profile's `watch.paths` |
| Bundler `tsConfigPath` | Bundler `tsconfig`; script entries remain owned by pack manifests |
| Generator pack paths, local UI screen modules and i18n data paths | Converted from Regolith workspace paths to project-relative paths |
| Local and exact exports | Exact per-pack paths; local defaults use `build/<project-name>_bp` and `_rp` |

Remote filters are recognized by their `github.com/bedrock-core/regolith-filters`
repository URL, not just their ID. Local wrappers are recognized only when their canonical
paths match this workspace's sibling `regolith-filters` repository. Other local modules and
forks require an explicit verified mapping with `--filter id=stage` or `id=core`.
That mapping names a built-in equivalent; it does not adapt or execute custom filter code.
Pinned filter versions produce a parity warning because built-in stages use the installed builder.

Pack modules determine behavior/resource classification, including arbitrary pack IDs.
Manifests must already use v3 and unique identities. If project `targetVersion` is missing,
the command can infer it when all available `min_engine_version` strings agree. Otherwise
use `--target-version`. Namespace can be inferred from agreeing stage settings; otherwise
use `--namespace`. Missing `type` and `worlds` become `minecraftBedrock` and an empty list.
Existing builder configuration is never replaced.

## Saving the result

```sh
yarn migrate path/to/config.json --write
yarn migrate path/to/config.json --write --output config.builder.json
```

In-place writes retain the original bytes in `config.json.regolith.bak`. Existing backups
and output files are never overwritten. A new output must sit beside the input so relative
project paths keep their meaning; relative `--output` values resolve from the input's directory.
The source is checked again before writing to avoid replacing intervening edits.

Every pack needs a destination. Supply explicit paths for development, world, no-export,
expression-based or multiple-target configurations:

```sh
yarn migrate config.json --profile default \
  --export default:behaviorPack=C:/Minecraft/development_behavior_packs/example \
  --export default:resourcePack=C:/Minecraft/development_resource_packs/example
```

The command previews these values unless `--write` is included. Explicit export replacements
replace the entire profile's export policy, including read-only or multiple-target behavior,
and produce a warning. To retain several destinations, create separate builder profiles.
Pack paths cannot overlap sources, each other, the project root or reserved builder directories.
Regolith export expressions and environment substitutions are never evaluated.

| Option | Purpose |
| --- | --- |
| `--profile name` | Select profiles, repeatable; all profiles are selected by default |
| `--namespace value` | Supply the intended project namespace |
| `--target-version value` | Supply the intended project targetVersion |
| `--export profile:pack=path` | Replace a profile's export map, repeatable for each pack |
| `--filter id=stage` | Assert a verified filter equivalent, repeatable |
| `--write` | Save only a complete conversion |
| `--output path` | With `--write`, create a sibling configuration |
| `--json` | Print structured diagnostics, draft config and readiness |
| `--help` | Show CLI usage |

Selected profiles can still reference unselected profiles; referenced filters are flattened,
while the referenced export destination is ignored. Unsupported referenced commands and
conditions remain errors.

## Manual conversion and acceptance

Conditions, shell commands, CLI arguments, parallel groups and custom filters require trusted
TS/JS plugins or separate profiles. Guides are unavailable and block automatic conversion.
Manifest variants and `extends` chains require per-pack manifest overrides
or a plugin that also handles variant cleanup. Unknown properties and unsupported stage settings
are reported at their configuration paths.

Review manifest script entries before building: `tsconfig.files` and `include` do not select
builder entry points. The command does not rewrite imports, compiler aliases or generated
declaration references. Generator declarations default to
`.bedrock-core/generated/mc/globals.d.ts`; i18n declarations live under
`.bedrock-core/generated/i18n`; UI screen keys live under `.bedrock-core/generated/ui`.
Update the project tsconfig to include the required declarations.
Translation runtime imports use `@bedrock-core/generated/i18n` and resolve from the producer.

Run the migrated profile against isolated export folders, compare pack artifacts with the
Regolith build, and perform the required Minecraft runtime checks before replacing that runner.

## Library API

```ts
import { migrateRegolithProject, writeMigration } from '@bedrock-core/builder/migrate';

const result = await migrateRegolithProject('config.json', {
  profiles: ['build'],
  exports: { build: { gameplay: './dist/BP', visuals: './dist/RP' } },
});

if (result.ready) {
  await writeMigration(result, 'config.builder.json');
}
```

`migrateRegolithConfig(input, options)` is the pure JSON transformation. It performs no file
inspection; pass `packKinds` for arbitrary pack IDs and any required metadata. The file API
adds manifest validation, type inference, local-wrapper verification and export-path checks.
Neither API validates complete content or proves output parity.

Source formats: [Regolith profiles](https://regolith-docs.readthedocs.io/en/stable/project-configuration/profiles/),
[Regolith export targets](https://regolith-docs.readthedocs.io/en/stable/project-configuration/export-targets/)
and [Project Config Standard](https://github.com/Bedrock-OSS/project-config-standard).
