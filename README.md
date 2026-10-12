# @bedrock-core/builder

Build tools for TS/JS Bedrock projects. The builder resolves plans, executes trusted plugins
in an isolated staged project and validates pack content before exporting. Manifest, generator,
guides, i18n, UI compiler and bundler stages activate automatically when their inputs exist.
Library callers can supply stage functions and additional artifact checks.

Run locally with `yarn build path/to/config.json` or `yarn watch path/to/config.json`.
All packages are private. `yarn release` prepares and verifies local package archives;
registry publication is disabled.

Create an addon with `yarn scaffold my-addon`. The `@bedrock-core/cli` workspace
owns the scaffold, builder profiles and example pack files. See the
[CLI package](packages/cli/README.md) for flags, generated commands and local archives.

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

Projects are implicitly Minecraft Bedrock, so no `type` field is needed. Prefer metadata in
this order: `$schema`, `targetVersion`, optional `namespace`, `name`, `description`, `authors`, then
the remaining fields. Validation accepts any key order.

The schema requires `authors` and preserves unused top-level metadata and other tool
namespaces, and rejects unknown builder fields, stage names and malformed hook placement.
Every built-in stage has an options schema under `schemas/`; plugin settings remain extensible.
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
`guides-project` demonstrates localized guide content and generated imports without installing
the guide/UI runtime stack.
Every build creates a `bedrock-core-build-*` folder in the OS temporary directory and copies
the project into its `project` subdirectory. Stages and plugins transform the copied pack files
in order. After final validation, each staged pack is published to its configured export folder;
the temporary folder is removed when the build finishes or fails. Authored pack files remain unchanged by the runner. Plugin failures,
validation failures and cancellation retain the previous export. A destination lock rejects
simultaneous exports. Cancellation is cooperative at step boundaries and through `context.signal`.
Project symlinks are currently unsupported. Plugins are trusted Node code, not sandboxed processes.

Built-in transformations and external modules use the same plugin contract. Each feature package
owns its processing, detection, workers and cache keys. Its `./plugin` entrypoint exports
`run(context, settings)` and may export `detect(context, settings)`. Types and helpers are available
from `@bedrock-core/builder-plugin`; implementation helpers stay inside the owning package.
See [plugin authoring](docs/plugins.md) for the module format, bundling hooks and runtime registry entrypoints.

The typed context supplies the project namespace, staged project/pack paths,
a generated directory, logger, cancellation signal and artifact/dependency registration. Artifact
IDs have one owner and must identify existing staged files. `context.outputPaths` provides the
resolved pack-to-destination map. Missing or duplicate IDs fail the build.
Result records expose IDs and owners; temporary workspace paths do not survive cleanup.
`context.reuse` provides invocation-scoped cache reuse with dependency tracking.
`context.registerBundleExtension` lets a feature contribute esbuild plugins, a JSX runtime
or project import preferences before bundling. Custom compiler plugins rebuild by default;
reuse requires an explicit implementation/settings version and tracked dependencies.
External steps may select `mode: "auto"` to use their module's detector; omission always runs them.

Define standalone Node filters directly by name: `"generate": { "script": "./filters/main.cjs" }`
under `bedrockCore.plugins`, then invoke `"plugin": "generate"` in profile `steps`.
Builder supplies conventional `BP`, `RP` and `data` folders, JSON arguments and Regolith
environment variables. Step `settings` go directly to the script. See [running Node filters](docs/regolith-node-filters.md) for profile
configuration, dependencies, pack mapping and a runnable local example.

Set `targets: "resource"`, `"behavior"`, or `"both"` on a script or module definition
to run it once per matching pack. Builder classifies current manifest modules;
pack IDs and folder names have no significance. Every invocation receives one
pack, and a failure prevents publication of the entire build. Without `targets`,
the plugin runs once for the project.

Selectors also accept `"targets": { "packs": ["gameplay"], "modules": ["data", "script"] }`.
IDs and modules intersect; module types match any listed capability and each pack runs once.
Module plugins can select `"scope": "project"` to run once with all matching packs.
`"scope": "pack"` without targets invokes the module for every configured pack.
`context.allPacks` and `context.inspectPacks()` expose the complete pack set in either scope.
Descriptors include selected manifest data, header identity, versions and local/external/API
dependencies. Local dependencies match header UUIDs; reciprocal dependencies are allowed
and do not change stage order. Local versions must match the selected target manifest.
Builder descriptors include `outputPath` for their selected export destination; scoped
`outputPaths` and default bundling contributions are restricted to the selected set.

Targeted module plugins receive `context.pack` with the current ID, path and type.
Their `context.packs` and `context.outputPaths` maps contain only that pack. Include
the pack ID in generated filenames and artifact IDs shared between invocations.
Targeted scripts receive the current pack as `BP` or `RP`, with the other folder
empty, plus `PACK_ID` and `PACK_TYPE` environment variables.

Producers can publish a generated module's import name once:

```ts
await context.registerArtifact('items', file, { importAs: '@bedrock-core/generated/items' });
```

Later compiler stages resolve it automatically. `context.generatedImports` exposes the current
build's registered names. Import names have one owner; conflicting producers fail the build.

`runBuild` from `@bedrock-core/builder/runner` accepts named stage functions or full plugin
replacements, and `validateArtifacts`.
Built-in stages load when needed. Their generated import names are registered by producers
and resolved by downstream compilers from the current staged build.
`BuildResult.stages` and build logs report `executed`, `skipped` or `cached` for each participating
stage. Default validation checks registered files and v3 manifest integrity. Full
Minecraft content validation and runtime acceptance require separate checks.

## Choose only what you use

`namespace` explicitly sets the default namespace for generated content. Each script
pack declares its own runtime identity in its `core.register()` call. `config.json` owns display name,
description, authors and Minecraft target; `package.json` owns npm identity and version.
Manifests retain stable header/module UUIDs and module declarations. Missing pack versions,
module versions, engine targets and authors inherit shared metadata; explicit values win.
Local manifest dependencies can use `{ "pack": "visuals" }`; native UUID/version fields
are generated after profile selection. Every exported manifest is complete native v3.

`@bedrock-core/generated/project` exports plain `project` metadata for authored sources.
The builder generates editor declarations in `.bedrock-core/generated/project.d.ts`;
include generated declarations in tsconfig. Generated runtime data contains no build config.

i18n, guides and UI settings accept `owner` and `resourcePack` IDs. i18n and guides discover
inputs separately in each pack; `owner` restricts discovery to one pack. UI uses
the sole script pack by default, or the sole pack when no script pack exists. Client output uses
the owner's sole direct local resource dependency; a resource owner may write into itself.
Multiple candidates require an explicit destination, which must still be declared as
a local dependency. External pack requirements are never writable destinations.

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
| Generator | `.ts` templates inside packs, excluding `scripts/`, `i18n/`, `guides/`, reserved producer inputs and declarations |
| Guides | `<pack>/guides/<locale>/**/*.md` or `.mdx` |
| i18n | `<pack>/i18n/<locale>.ts`, `.js`, `.mts` or `.mjs`, or linked pack `texts/*.lang` |
| UI compiler | Pack `scripts/**/*.screen.tsx`, generated UI imports, or framework declarations with an installed UI toolkit |
| Bundler | Script modules declared in staged manifests |

Detection runs after each stage's before hooks. After hooks run even when automatic detection
skips a stage. Explicitly disabled stages have no boundary, so hooks targeting them are rejected.
Guides read locale directories under each pack's `guides/`, preserve Markdown/MDX authoring,
and produce separate manifests, language sections and screens before i18n and UI run.
Editor imports use `@bedrock-core/generated/guides/<packId>`; guide build sources stay
out of exported packs. See the
[guides package](packages/guides/README.md) for authoring, options and runtime requirements.

For example, a profile can skip translations while bundling detected scripts:

```json
{
  "stages": { "i18n": false },
  "export": { "gameplay": "./dist/BP", "visuals": "./dist/RP" }
}
```

The distribution separates the runner and independently installable stage packages.
A shared plugin contract has no Minecraft runtime dependency.
Bundling, templates, guides, translations and validation offer standalone functions with
explicit inputs and outputs. UI compilation runs through the builder's `ui-compiler` stage.

| Component   | Build-time purpose                                | Standalone boundary                                                         |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Runner      | Configuration, scheduling, staging and export     | No server/UI runtime required                                               |
| Manifest    | Resolve selected files and relative inheritance                    | Explicit manifest inputs and dependency records                             |
| Generator   | Execute typed content templates                   | Shared esbuild bundler and template dependencies; no framework runtime       |
| Bundler     | Compile an explicit TS/JS entry                   | esbuild, TypeScript config parsing and feature-owned compiler extensions |
| i18n        | Generate language files and translation artifacts | Shared esbuild bundler; runtime translation helpers when code uses them     |
| Guides      | Compile guide content                             | MDX tooling alone for content; guide/UI runtime packages for screen compilation |
| UI compiler | Compile screen modules into pack assets           | Builder stage using the project's installed UI toolkit                       |
| Validation  | Check final pack JSON and schema coverage          | Mojang schemas, Ajv and JSON parsing; no framework or script compiler needed |

Each stage package can be installed independently. Runtime apps
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

Build and watch automatically reuse compiled TS/JS files and guide pages. Each script entry, generator template
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
Guide pages reuse source and texture inputs; navigation and localization are assembled from
current pages and categories. UI screen modules and rendered results also reuse their unchanged inputs. The shared toolkit
is bundled once, and the current screen set is linked into complete pack outputs each build.
Staging and export still copy complete packs, and the first build compiles every file.
Schema declarations and optional vanilla downloads keep their
own content/freshness caches.

## UI compilation

Place default-exported screen components in pack `scripts/**/*.screen.tsx` files. The UI stage
uses the addon's installed compiler, runtime, JSX and translation libraries. It emits the
current screen set into the selected resource pack, merges vanilla hooks, writes language
sections and updates container hosts in their owning behavior packs. Compiled screens require
a resource pack; container screens also require their named entity or block definition.

The project namespace is the default UI namespace. Manifest script entries receive runtime
registration automatically. Static form screens ship their compiled tables; live screens keep
their component imports. UI conditional JSX is transformed identically during compilation
and script bundling. No extra entry point or generated import map is required.

Framework declarations in manifest entries are evaluated with `core.register` intercepted.
Tagged apps provide their `compiled` modules, default screen records and optional `shape()`
exports. Shape functions receive declared data and manifest display fields. Additional local
or package screen records can be selected with `screens`.

```json
{
  "stages": {
    "ui-compiler": { "testMetadata": true, "pretty": { "size": 2 } }
  }
}
```

`namespace`, `testMetadata`, `stamp`, `screens`, `tsconfig` and `pretty` are described by
`schemas/ui-compiler.schema.json`. Set the stage to `false` to disable it. Editor screen keys
live in `.bedrock-core/generated/ui/screens.generated.d.ts`. Include that declaration in the
project tsconfig. The generated runtime import is `@bedrock-core/generated/ui` (`ui:bundle`).
The optional metadata sidecar fingerprints the UI bytes emitted by this stage.

See [the UI adapter package](packages/ui-compiler/README.md) for stage options and dependencies.

## Extension vocabulary

A plugin names a `module` exporting `run(context, settings)` or a standalone Node `script`;
a step invokes that name with JSON settings at one boundary. Built-in stages
run in stable order. Hooks targeting disabled stages fail. Modifying hooks run before
final validation and export. Plugins execute as trusted Node code.

## Manifest variants

Keep manifest documents in each pack. The manifest stage resolves `manifest.json` by default;
a profile can select another manifest file for one or more configured packs:

```json
{
  "pretty": { "indent": "tab" },
  "debug": true,
  "stages": {
    "manifest": {
      "manifestPath": "./packs/BP/manifest.test.json"
    }
  },
  "export": { "behaviorPack": "./dist/tests/BP" }
}
```

`manifestPath` accepts a project-relative path or an array with at most one source per pack.
Unselected packs use their canonical manifest. A variant can declare `"extends": "./manifest.json"`;
each reference resolves relative to its declaring file. Objects merge recursively; arrays and
scalars replace the inherited value. Restate the complete `modules` or `dependencies` array when
changing it. All selected manifests are resolved before writing any result.

Resolved documents are written as `manifest.json` in staging. Every configured pack loses its
staged `manifest.*.json` variants, including packs without an explicit selection. Authored files
remain intact. Manifest sources and ancestors participate in watch dependencies. The public
`resolveManifest` helper returns a resolved document and its inputs without writing files.

Profile-level `pretty` and `debug` are defaults for every built-in stage. Stage settings replace
these values, including explicit `false`; supplying defaults does not activate automatic stages.
An omitted or false `pretty` emits compact JSON; an object selects indentation. Stages use the
shared settings relevant to their output.

```sh
yarn build examples/script-only/config.json tests
```

## Pack export paths

`export` maps each pack ID to its exact destination folder. Paths resolve relative to config.json;
absolute paths are supported. Every configured pack needs a destination, and unknown pack IDs
fail before plugin execution. Missing parent folders are created. Paths support `%VAR%`,
`$VAR` and `${VAR}` using the current process environment. Undefined or empty variables
fail before plugin execution. Variable names follow the platform's casing rules. Expansion
is a single substitution pass; variable values are not expanded again. Pack names and UUIDs
are not appended to destinations.

```json
{
  "export": {
    "gameplay": "./dist/BP",
    "visuals": "%APPDATA%/Minecraft Bedrock/Users/Shared/games/com.mojang/development_resource_packs/my-addon"
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
Manifest variants can change UUIDs while keeping the configured pack path.

All candidates are copied beside their destinations before any replacement. Backups remain until
every pack is published; ordinary failures and cancellation restore prior outputs. Rollback
failures retain backups and report their paths. A lock for each destination prevents overlapping
builds. Replacements happen sequentially. `BuildResult.outputPaths` reports resolved destinations;
`BuildResult.packs` contains final manifest classification and published paths.
The standalone `exportPacks({ packs, paths, signal })` API from `@bedrock-core/builder/export`
uses the same validation and publication transaction without the runner.
`resolveExportPaths` accepts an optional environment map as its fourth argument;
`exportPacks` accepts the same override as `environment`.

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

The i18n stage detects `<pack>/i18n/<locale>.ts` default-exported objects. It uses the project
namespace and each staged manifest's pack type. Runtime JSON keeps named interpolation
variables, while language files use positional placeholders. Library resources, plural forms,
nesting, handwritten language entries and optional vanilla strings are supported.

Translations belong to each owner pack; application strings go only to its resource
destination. `client: false` compiles runtime data without writing language files.
Shared display fields supply typed `meta.name`, `meta.description` and `meta.creator`
defaults; locale modules can override them. Conflicting handwritten/generated values
fail before translation outputs change. Pack name/description entries stay pack-local.

No stage or generated-import configuration is required for the default locale directory.
Each owner exposes `@bedrock-core/generated/i18n/<packId>` with its own resource types;
the unqualified runtime import is resolved by the consuming pack. Editor declarations
are written under `.bedrock-core/generated/i18n/<packId>`. Locale sources are protected
from JSON template generation and remain available until consumers finish, then are
omitted from published packs. Multiple owners contribute independent sections into a
shared linked resource pack; conflicting client keys fail rather than replace values.
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
two-space indentation. Cached declarations are reused. Final pack checks run separately from
declaration generation; in-game acceptance verifies runtime behavior. The generator example has its own tsconfig:

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
modifying hooks and before export. Optional manifest fields and dependency compatibility require
additional checks. Pack JSON receives final schema validation; in-game behavior needs native acceptance.
The standalone `validatePackManifests` function
accepts a pack-name-to-directory map and requires no runner.
Manifest field requirements follow the [Microsoft manifest reference](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/addonsreference/packmanifest).
See [the package](packages/bundler/README.md)
for standalone use and limits.

```sh
node bin/build.ts examples/script-only/config.json
```

## Final content validation

Every pack JSON document receives syntax checks after modifying hooks. Matching behavior and
resource documents receive checks against the bundled Mojang schema catalog. Comments and
trailing commas are accepted. Schema errors include pack paths and JSON pointers and prevent
export. Unchanged documents reuse checks automatically; changes to their schemas invalidate reuse.
`BuildResult.validation` reports the schema version and per-file coverage. Unknown JSON and
unavailable upstream schemas receive syntax checks, with unavailable schemas reported explicitly.
The documented language catalog array is validated separately. These checks do not establish
Molang, assets, JSON UI binding/layout or client behavior. See the
[validation package](packages/validation/README.md).

The [release guide](docs/releasing.md) describes independent package installation, clean-consumer
checks and addon/native acceptance. The workspace-root PLAN.md owns delivery order and acceptance criteria.
