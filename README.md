# @bedrock-core/builder

Build tools for TS/JS Bedrock projects. This private package resolves plans and executes trusted
plugins in an isolated staged project. Manifest, generator, i18n and bundler stages are integrated; other built-in
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

The planner reads `config.json` without importing plugin code. Automatic stage boundaries appear
in the plan; input detection happens during execution after their before hooks. Execution resolves
paths relative to that file. `bedrockCore.formatVersion` is independent of the
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
Manifest, generator, i18n and bundler options have schemas under `schemas/`; plugin settings remain extensible.
Cross-reference checks (plugin names and enabled boundaries) belong to the planner. Each profile's
`export` maps configured pack IDs to destination paths; the runner checks that every pack has one.
Watch settings belong to each profile; script entries come from pack manifests.

## Execute plugins

```sh
node bin/build.ts examples/plugin-project/config.json
```

The example generates JSON, registers it and consumes it in a second TS step.

The `examples` directory contains independent sibling projects, each with its own config and
pack manifests. `script-only` uses `packs/BP/scripts/main.ts`; `plugin-project` demonstrates
build hooks in a data-only behavior pack.
Each pack is written directly to its configured export folder. Authored pack files remain unchanged by the runner. Plugin failures,
validation failures and cancellation retain the previous export. A destination lock rejects
simultaneous exports. Cancellation is cooperative at step boundaries and through `context.signal`.
Project symlinks are currently unsupported. Plugins are trusted Node code, not sandboxed processes.

Plugins export `run(context, settings)`. The typed context supplies the project namespace, staged project/pack paths,
a generated directory, logger, cancellation signal and artifact/dependency registration. Artifact
IDs have one owner and must identify existing staged files. `context.outputPaths` provides the
resolved pack-to-destination map. Missing or duplicate IDs fail the build.
Result records expose IDs and owners; temporary workspace paths do not survive cleanup.

Producers can publish a generated module's import name once:

```ts
await context.registerArtifact('items', file, { importAs: '@bedrock-core/generated/items' });
```

Later compiler stages resolve it automatically. `context.generatedImports` exposes the current
build's registered names. Import names have one owner; conflicting producers fail the build.

`runBuild` from `@bedrock-core/builder/runner` accepts named stage functions and `validateArtifacts`.
Manifest, generator, i18n and bundler stages load when needed. Explicitly enabled unavailable stages
fail before plugins run; automatically detected unavailable stages fail at their boundary.
`BuildResult.stages` and build logs report `executed`, `skipped` or `cached` for each participating
stage. Default validation checks registered files and v3 manifest integrity. Full
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
so manifest-changing steps affect the final classification. Destination paths are explicit;
classification does not change them. Other module types remain exportable to their configured paths.

Profiles detect built-in stages by default. A script-only project needs no `stages` configuration.
Omission or `"auto"` checks for inputs, `false` disables a stage, and `true` or an options object
enables it even without detected inputs. Installed npm packages do not activate unrelated stages.

| Stage | Automatic input detection |
| --- | --- |
| Manifest | Configured pack manifests |
| Generator | `.ts` templates inside packs, excluding `scripts/` and declarations |
| Guides | `guides/**/*.md` or `.mdx` |
| i18n | `i18n/<locale>.ts`, `.js`, `.mts` or `.mjs` |
| UI compiler | Pack `scripts/**/*.screen.tsx` modules |
| Bundler | Script modules declared in staged manifests |

Detection runs after each stage's before hooks. After hooks run even when automatic detection
skips a stage. Explicitly disabled stages have no boundary, so hooks targeting them are rejected.
Guides and UI compilation remain unimplemented; their detected inputs report an unavailable-stage
error unless that stage is disabled.

For example, a profile can skip translations while bundling detected scripts:

```json
{
  "stages": { "i18n": false },
  "export": { "gameplay": "./dist/BP", "visuals": "./dist/RP" }
}
```

The intended distribution separates the runner and independently installable stage packages.
A shared plugin contract has no Minecraft runtime dependency.
Standalone stage functions accept explicit inputs and return artifacts; builder adapters schedule
them. `packages/bundler`, `packages/generator` and `packages/i18n` implement this boundary;
guides and UI compilation remain pending.

| Component   | Build-time purpose                                | Standalone boundary                                                         |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Runner      | Configuration, scheduling, staging and export     | No server/UI runtime required                                               |
| Manifest    | Apply profile overrides to staged manifests                       | Explicit manifest inputs and outputs                                        |
| Generator   | Execute typed content templates                   | Shared esbuild bundler and template dependencies; no framework runtime       |
| Bundler     | Compile an explicit TS/JS entry                   | esbuild and TypeScript config parsing; screen JSX integration is pending    |
| i18n        | Generate language files and translation artifacts | Shared esbuild bundler; runtime translation helpers when code uses them     |
| Guides      | Compile guide content                             | MDX tooling; translations and guide runtime when content requires them      |
| UI compiler | Compile screen modules into pack assets           | UI compiler libraries; runtime registration dependencies for generated code |

Unimplemented rows are extraction targets. Runtime apps
such as config, catalog and guides have their own dependencies; changing the builder does not
remove those. Document each extracted package's direct dependencies, consumed/provided artifact
IDs, optional integrations and runtime requirements. Declare unconditional prerequisites and
conditional requirements based on selected features; fail with the missing artifact and its
provider or external-input option.

Raw JSON imports need no translation or guide stage. Generated imports require either an active
producer or an explicitly registered existing artifact. Producers register built-in import names;
compiler adapters resolve them automatically. Optional `generatedImports` settings override those
defaults or name custom artifacts. Import resolution uses the current build's registered files.
Imports do not enable additional stages; producer inputs determine automatic participation.

## Incremental builds

Build and watch automatically reuse compiled TS/JS files. Each script entry, generator template
and locale module checks its transitive imports, resolver candidates, compiler configuration and
Node/compiler versions. Unrelated edits keep compiled files cached; editing a shared helper
rebuilds its consumers. Installed package code and metadata, tsconfig path mappings, inherited
configs and JSONC configs participate in dependency tracking. No cache registration is required.

Data-only objects, relative TS/JS/JSON imports and simple Many callbacks can reuse generated
documents automatically. Templates with runtime calls, side effects, Node I/O or environment
access execute every build while reusing their unchanged compiled code. Locale modules also
evaluate freshly. Default exports and async template behavior retain their contract. Generated
JSON is compared by content, so an unchanged output keeps its consuming script cached. Plugin
hooks execute each build.

`BuildResult.compilations` reports `executed` or `cached` for compiled files and generator outputs.
Stage logs distinguish compilation from template evaluation. Set `"cache": false` on a profile to bypass reuse, or remove
`.bedrock-core/cache/build`. Cache hits restore files into fresh staging and preserve artifact
registration and dependency tracking. Final validation and coordinated export always run.

See [automatic compilation reuse](docs/incremental.md) for examples and dependency boundaries.
UI compilation is not integrated yet. Staging and export still copy complete packs, and the
first build compiles every file. Schema declarations and optional vanilla downloads keep their
own content/freshness caches.

## Extension vocabulary

A plugin supplies a module; a step invokes it with JSON settings at one boundary. Built-in stages
run in stable order. Hooks targeting disabled stages fail. Modifying hooks run before
final validation and export. Plugins execute as trusted Node code.

## Manifest overrides

The manifest stage preserves staged v3 manifests by default. Supply per-pack overrides to change them:

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
  "export": { "behaviorPack": "./dist/tests/BP" }
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

## Pack export paths

`export` maps each pack ID to its exact destination folder. Paths resolve relative to config.json;
absolute paths are supported. Every configured pack needs a destination, and unknown pack IDs
fail before plugin execution. Missing parent folders are created. Path strings are literal,
without environment-variable expansion or appended pack names and UUIDs.

```json
{
  "export": {
    "gameplay": "./dist/BP",
    "visuals": "C:/Minecraft/development_resource_packs/my-addon"
  }
}
```

Use the same map for development packs. Point each value to that pack's folder inside the
installation's `development_behavior_packs` or `development_resource_packs` directory, following
[Microsoft's development-folder guidance](https://learn.microsoft.com/en-us/minecraft/creator/documents/gettingstarted?view=minecraft-bedrock-stable).
Local folders, game folders and server folders use the same export mechanism.

Destinations must be separate from each other and authored packs. Existing nonempty destinations
must contain a valid v3 pack manifest. A configured destination is an owned pack output;
subsequent exports replace its contents, including stale files. Sibling folders remain intact.
Manifest overrides can change UUIDs while keeping the configured path.

All candidates are copied beside their destinations before any replacement. Backups remain until
every pack is published; ordinary failures and cancellation restore prior outputs. Rollback
failures retain backups and report their paths. A lock for each destination prevents overlapping
builds. Replacements happen sequentially. `BuildResult.outputPaths` reports resolved destinations;
`BuildResult.packs` contains final manifest classification and published paths.
The standalone `exportPacks({ packs, paths, signal })` API from `@bedrock-core/builder/export`
uses the same validation and publication transaction without the runner.

## Regolith configuration migration

Preview a configuration migration without changing files:

```sh
yarn migrate path/to/config.json
```

The command converts supported `@bedrock-core` filters, profile references, watch paths
and local/exact export targets. Shared metadata and other tool sections are retained.
Only manifests already using v3 are supported. Project code, tsconfig, manifest variants
and pack assets are not rewritten. Unsupported behavior produces diagnostics and prevents writing.

Use `--write` to update the source config with an exclusive `.regolith.bak` backup, or
`--write --output config.builder.json` to create a sibling config. Development exports
need exact per-pack folders supplied with `--export profile:pack=path`.
See [migration options and limits](docs/migration.md).

## Watch builds

```sh
yarn watch examples/script-only/config.json
yarn watch examples/script-only/config.json tests
```

Watch mode builds immediately, then rebuilds and exports on project changes. It keeps watching
after compiler, plugin, config or validation failures. Changes arriving during a build are
coalesced into subsequent full builds; runs never overlap. Configuration is read each time.
Local plugin modules and their relative helpers execute from each fresh staged copy.

Optional profile settings are `"watch": { "debounceMs": 100, "paths": ["../shared-inputs"] }`.
Project files, selected plugins, declared dependencies and extra paths are observed. Local
export folders from all profiles, temporary export directories, `.git` and generated workspaces are
ignored. Explicit dependencies in node_modules are observed individually. Former output paths
remain ignored after config edits. Native filesystem notifications require a local filesystem;
watch mode has no polling fallback. Ctrl+C stops watching and cancels the active build.
Library callers use `watchBuild` with an AbortSignal and optional result/error callbacks.

## Content generation

The generator detects `.ts` default-exported templates inside configured packs. An options object
can customize generation or enable editor declarations without template inputs:

```json
{
  "stages": {
    "generator": {
      "pretty": { "indent": "space", "size": 2 }
    }
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
Registered import names resolve automatically; optional `generatedImports` overrides map specifiers
to earlier artifact IDs. `tsconfig` selects compiler
settings. The standalone `generateTemplates` API writes JSON beside explicit inputs and leaves
sources intact. It needs only the shared esbuild bundler and the template's own dependencies.
See [the generator package](packages/generator/README.md) for its API and limits.

## Translations

The i18n stage detects `i18n/<locale>.ts` default-exported objects. It uses the project
namespace and each staged manifest's pack type. Runtime JSON keeps named interpolation
variables, while language files use positional placeholders. Library resources, plural forms,
nesting, handwritten language entries and optional vanilla strings are supported.

No stage or generated-import configuration is required for the default locale directory.
An options object can change the directory or enable optional features; `"i18n": false` skips it.

Editor declarations are generated under `.bedrock-core/generated/i18n`; include that directory
in the project tsconfig. Build [the i18n example](examples/i18n-project/README.md) with
`yarn build examples/i18n-project/config.json`. The standalone `compileI18n` API needs no runner
or framework runtime. See [the i18n package](packages/i18n/README.md) for settings, artifacts,
runtime requirements and usage-scan limits.

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

The bundler detects script modules automatically. An options object customizes compilation.
The staged pack manifests declare all script entries; no separate entry or destination
configuration is needed:

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
Producer import names resolve automatically; `generatedImports` optionally overrides them or
maps custom specifiers to artifact IDs registered by earlier steps. Ordinary JSON
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
