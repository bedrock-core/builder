# @bedrock-core/builder

Build tools for TS/JS Bedrock projects. This private package resolves plans and executes trusted
plugins in an isolated staged project. Manifest, generator and bundler stages are integrated; other built-in
compilers and full Minecraft content validation remain pending. Library callers can supply stage
functions and a final artifact validator.

## Inspect a plan

```sh
corepack yarn install --immutable
node bin/plan.ts examples/script-only/config.json
yarn typecheck
yarn lint
yarn test
```

The planner reads `config.json` without importing plugin code. Execution resolves paths relative
to that file. `bedrockCore.formatVersion` is independent of the
shared [Project Config Standard](https://github.com/Bedrock-OSS/project-config-standard).

## Configuration schema

ESLint and @stylistic own code formatting. `yarn lint:fix` applies fixes; `yarn check`
runs lint, strict typechecking and tests. VS Code applies ESLint fixes on explicit saves.

Set `"$schema": "./schemas/config.schema.json"` when config.json is beside the schemas directory.
The package exports `@bedrock-core/builder/schemas/config.schema.json` for installed projects; set
`$schema` to its relative path under node_modules for editor completion. No hosted URL is required.
The plan CLI validates the complete project configuration with this schema before planning.
Library callers can use `validateConfig` from `@bedrock-core/builder/config`.

The schema requires `authors` and preserves unused top-level metadata and other tool
namespaces, and rejects unknown builder fields, stage names and malformed hook placement.
Manifest, generator and bundler options have schemas under `schemas/`; plugin settings remain extensible.
Cross-reference checks (plugin names and enabled boundaries) belong to the planner. Export
supports a dedicated local directory inside the project. Deployment and watch settings belong
to each profile; script entries come from pack manifests.

## Execute plugins

```sh
node bin/build.ts examples/plugin-project/config.json
```

The example generates JSON, registers it and consumes it in a second TS step.

The `examples` directory contains independent sibling projects, each with its own config and
pack manifests. `script-only` uses `packs/BP/scripts/main.ts`; `plugin-project` demonstrates
build hooks in a data-only behavior pack.
Output packs appear under `dist/<packId>/`. Authored pack files remain unchanged by the runner. Plugin failures,
validation failures and cancellation retain the previous export. A destination lock rejects
simultaneous exports. Cancellation is cooperative at step boundaries and through `context.signal`.
Project symlinks are currently unsupported. Plugins are trusted Node code, not sandboxed processes.

Plugins export `run(context, settings)`. The typed context supplies staged project/pack paths,
a generated directory, logger, cancellation signal and artifact/dependency registration. Artifact
IDs have one owner and must identify existing staged files. Missing or duplicate IDs fail the build.
Result records expose IDs and owners; temporary workspace paths do not survive cleanup.

`runBuild` from `@bedrock-core/builder/runner` accepts named stage functions and `validateArtifacts`.
Manifest, generator and bundler stages load only when selected; other unimplemented stages fail before
plugin execution. Default validation checks registered files and v3 manifest integrity. Full
Minecraft content validation and runtime acceptance require separate checks.

Implementation files are strictly typed `.ts`, executed directly by Node 22.18 or later.
`yarn typecheck` emits no code and enforces erasable syntax. Node does not apply tsconfig
aliases or support TSX in plugins. Native TS under node_modules is unsupported, so publishing
this private package will require a JavaScript distribution with declarations.

## Choose only what you use

`packs` maps arbitrary names to pack directories. Include any number of packs; each manifest's
modules determine its type. For example, `gameplay`, `extraGameplay`, `visuals` and `theme` can
identify two behavior and two resource packs. Names carry no type meaning. Only declared packs
are exported. Intermediate build files use the generated workspace.

The current staged manifest is read when a stage needs pack information and again before export,
so manifest-changing steps affect the final classification. Export metadata records the inferred
development folder for behavior/resource packs. Profiles can deploy to these folders after
validation.
Other module types remain exportable with no inferred behavior/resource destination.

Profiles explicitly select built-in stages. An absent stage is disabled. A bundler-only project
does not enable guides, translations, UI compilation or the server framework. A complete stack
will be an explicit preset. Installed npm dependencies and selected build stages are separate.

The intended distribution separates the runner, independently installable stage packages and
a convenience stack preset. A shared plugin contract has no Minecraft runtime dependency.
Standalone stage functions accept explicit inputs and return artifacts; builder adapters schedule
them. `packages/bundler` and `packages/generator` implement this boundary; other stage packages remain pending.

| Component   | Build-time purpose                                | Standalone boundary                                                         |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Runner      | Configuration, scheduling, staging and export     | No server/UI runtime required                                               |
| Manifest    | Apply profile overrides to staged manifests                       | Explicit manifest inputs and outputs                                        |
| Generator   | Execute typed content templates                   | Shared esbuild bundler and template dependencies; no framework runtime       |
| Bundler     | Compile an explicit TS/JS entry                   | esbuild only; screen JSX integration is pending                             |
| i18n        | Generate language files and translation artifacts | Runtime translation helpers only when code uses them                        |
| Guides      | Compile guide content                             | MDX tooling; translations and guide runtime when content requires them      |
| UI compiler | Compile screen modules into pack assets           | UI compiler libraries; runtime registration dependencies for generated code |

Unimplemented rows are extraction targets. Runtime apps
such as config, catalog and guides have their own dependencies; changing the builder does not
remove those. Document each extracted package's direct dependencies, consumed/provided artifact
IDs, optional integrations and runtime requirements. Declare unconditional prerequisites and
conditional requirements based on selected features; fail with the missing artifact and its
provider or external-input option. Never silently enable the entire stack.

Raw JSON imports need no translation or guide stage. Generated imports require either a selected
producer or an explicitly configured existing artifact. Import resolution must not use stale
generated files from a previous build. Current generator and bundler adapters resolve explicit
artifact mappings and reject missing IDs. Automatic prerequisite inference remains pending.

## Extension vocabulary

A plugin supplies a module; a step invokes it with JSON settings at one boundary. Built-in stages
run in stable order. Hooks targeting absent or disabled stages fail. Modifying hooks run before
final validation and export. Plugins execute as trusted Node code.

## Manifest overrides

Enable `manifest` with `true` to preserve staged v3 manifests, or supply per-pack overrides:

```json
{
  "stages": {
    "manifest": {
      "packs": {
        "behaviorPack": {
          "scriptEntry": "scripts/tests.js",
          "header": { "name": "Test build" }
        }
      }
    },
    "bundler": { "debug": true }
  },
  "export": { "path": "./dist" }
}
```

`scriptEntry` overrides the sole script module. For multiple script modules, use `modules`
with module UUID keys and field patches, for example `modules: { "<uuid>": { "entry":
"scripts/tests.js" } }`. `header` and `metadata` objects merge recursively; arrays and
`dependencies` are replaced when supplied. Other fields and UUIDs are retained. Pack IDs and
module UUID selectors must exist. Later hooks can modify the staged result before bundling.
Every resulting manifest is registered as `manifest:<packId>` and validated before export.
`transformManifest` is a standalone, immutable JSON transformation with no runner dependency.

```sh
yarn build examples/script-only/config.json tests
```

## Development deployment

Add `"deploy": true` to a profile to publish to the Windows retail installation. Use
`"deploy": { "channel": "preview" }` for Preview, or `"deploy": { "path": "./minecraft" }`
for an explicit com.mojang root relative to config.json. A custom absolute path also works.
Other platforms require an explicit path. Default installation directories must exist.
`false` or omission disables deployment.

The defaults follow [Microsoft's Windows storage locations](https://learn.microsoft.com/en-us/minecraft/creator/documents/gdkpcprojectfolder).
Packs are routed by their final manifests to `development_behavior_packs/<headerUuid>` or
`development_resource_packs/<headerUuid>`. Unsupported pack types fail deployment. Existing
UUID folders must identify the same pack; unrelated folders are retained. Development folders
and authored packs must be separate. Stale files in a replaced pack are removed.

Deployment candidates are prepared before any replacement, with backups retained until both
deployment and local publication succeed. Ordinary failures restore prior packs and local
output. Rollback failures retain backups and report their location. A destination lock prevents
overlapping deployments. Replacements happen sequentially; Minecraft should reload packs after
the build completes. `BuildResult.deployments` reports installed paths.
`deployPacks` also accepts explicit source packs and a destination root without a runner.

## Watch builds

```sh
yarn watch examples/script-only/config.json
yarn watch examples/script-only/config.json tests
```

Watch mode builds immediately, then rebuilds and redeploys on project changes. It keeps watching
after compiler, plugin, config or validation failures. Changes arriving during a build are
coalesced into subsequent full builds; runs never overlap. Configuration is read each time.
Local plugin modules and their relative helpers execute from each fresh staged copy.

Optional profile settings are `"watch": { "debounceMs": 100, "paths": ["../shared-inputs"] }`.
Project files, selected plugins, declared dependencies and extra paths are observed. Local
output, deployment folders, temporary export directories, `.git` and generated workspaces are
ignored. Explicit dependencies in node_modules are observed individually. Former output paths
remain ignored after config edits. Native filesystem notifications require a local filesystem;
watch mode has no polling fallback. Ctrl+C stops watching and cancels the active build.
Library callers use `watchBuild` with an AbortSignal and optional result/error callbacks.

## Content generation

Enable `generator` to evaluate TS/JS default exports as JSON templates inside configured packs:

```json
{
  "stages": {
    "generator": {
      "pretty": { "indent": "space", "size": 2 }
    },
    "bundler": true
  }
}
```

`items/item.ts` emits `items/item.json`. Single templates export plain objects checked with
`satisfies Entity`, `satisfies Block` or another document type. Multiple outputs use a raw
`[nameFn, dataFn, items]` default export checked with `satisfies Many<Options, Document>`.
`defineTemplate` and `defineMany` are optional, automatically available helpers.
Templates can import project TS/JS, JSON, installed npm packages and Node built-ins. Default
discovery selects `.ts` files outside pack script directories and declaration files. Configure
`include` and `exclude` globs to select fewer templates; keep shared helpers outside packs or
exclude them. File and folder names do not infer the document type.

The adapter removes consumed templates only from staging. Generated documents replace staged
JSON at the same path; repeated names retain the last emitted document. Authored JSON remains
unchanged. Artifacts are registered as `generator:<packId>:<packRelativePath>`.
`generatedImports` maps import specifiers to earlier artifact IDs; `tsconfig` selects compiler
settings. The standalone `generateTemplates` API writes JSON beside explicit inputs and leaves
sources intact. It needs only the shared esbuild bundler and the template's own dependencies.
See [the generator package](packages/generator/README.md) for its API and limits.

```sh
yarn build examples/generator-project/config.json
```

The generator stage prepares Minecraft editor declarations by default from Mojang's schema
catalog. Include `.bedrock-core/generated/mc/globals.d.ts` alongside authored sources in the
project's tsconfig after the first build. `types: false` disables this; `schemaVersion` pins
the schema package, and `typesDir`, `typePrefix`, `strict` and `maxAgeHours` control output and
checking. Small single-use types are inlined, repeated shapes share declarations, and output uses
two-space indentation. Cached declarations are reused. Minecraft content validation and in-game acceptance
remain separate checks. The generator example has its own tsconfig:

```sh
yarn exec tsc --project examples/generator-project/tsconfig.json
```

## Bundler settings

Enable `bundler` with `true` or an options object. The staged pack manifests declare all
script entries; no separate entry or destination configuration is needed:

```json
{
  "stages": {
    "bundler": { "debug": true }
  }
}
```

Every behavior pack's script modules are bundled automatically. A manifest entry such as
`scripts/main.js` resolves to the matching `scripts/main.ts`, `.tsx`, `.mts` or `.cts` source,
or the JavaScript entry itself. Multiple TypeScript candidates are ambiguous; a `.js` output
already beside a TypeScript source is a conflict. Script filenames follow the manifest exactly.
Data-only behavior packs and resource packs need no script build. A manifest stage or plugin
running before bundling can change the staged entry, including selecting a test script.

`debug`, `target`, `tsconfig`, `external` and `generatedImports` apply to every bundle.
`generatedImports` maps specifiers to artifact IDs registered by earlier steps. Ordinary JSON
imports need no producer. Artifacts are named `bundler:<packId>:<manifestEntry>:script` and
`bundler:<packId>:<manifestEntry>:sourcemap`. Inputs remain intact until all bundles complete,
then consumed TypeScript sources inside script packs are removed from staging. Authored files
remain unchanged. Other scripts are retained.

Only manifest v3 is supported. Pack/module versions and `min_engine_version` use SemVer strings.
Final validation checks headers, module identities and versions, unique UUIDs across all packs,
script language and entry paths, and the existence of declared script files. It runs after
modifying hooks and before export. Optional manifest fields, dependency compatibility and
in-game content require separate validation. The standalone `validatePackManifests` function
accepts a pack-name-to-directory map and requires no runner.
Manifest field requirements follow the [Microsoft manifest reference](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/addonsreference/packmanifest).
See [the package](packages/bundler/README.md)
for standalone use and limits.

```sh
node bin/build.ts examples/script-only/config.json
```

The workspace-root PLAN.md owns delivery order and acceptance criteria.
