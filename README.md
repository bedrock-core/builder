# @bedrock-core/builder

Build tools for TS/JS Bedrock projects. This private package resolves plans and executes trusted
plugins in an isolated staged project. The standalone bundler is integrated; other built-in
compilers and Minecraft schema validation remain pending. Library callers can supply stage
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

Set `"$schema": "../config.schema.json"` when the schema is one directory above the config.
The package exports `@bedrock-core/builder/config.schema.json` for installed projects; set
`$schema` to its relative path under node_modules for editor completion. No hosted URL is required.
The plan CLI validates the complete project configuration with this schema before planning.
Library callers can use `validateConfig` from `@bedrock-core/builder/config`.

The schema requires `authors` and preserves unused top-level metadata and other tool
namespaces, and rejects unknown builder fields, stage names and malformed hook placement.
Stage/plugin settings stay extensible until their packages provide their own schemas.
Cross-reference checks (plugin names and enabled boundaries) belong to the planner. Export
supports a dedicated local directory inside the project. Entry-point and watch configuration
will be added with their implementations.

## Execute plugins

```sh
node bin/build.ts examples/plugin-project/config.json
```

The example generates JSON, registers it and consumes it in a second TS step.

The `examples` directory contains independent sibling projects, each with its own config and
pack manifests. `script-only` uses `packs/BP/scripts/main.ts`; `plugin-project` demonstrates
build hooks in a data-only behavior pack.
Output packs appear under `dist/<packId>/`. Sources remain unchanged by the runner. Plugin failures,
validation failures and cancellation retain the previous export. A destination lock rejects
simultaneous exports. Cancellation is cooperative at step boundaries and through `context.signal`.
Project symlinks are currently unsupported. Plugins are trusted Node code, not sandboxed processes.

Plugins export `run(context, settings)`. The typed context supplies staged project/pack paths,
a generated directory, logger, cancellation signal and artifact/dependency registration. Artifact
IDs have one owner and must identify existing staged files. Missing or duplicate IDs fail the build.
Result records expose IDs and owners; temporary workspace paths do not survive cleanup.

`runBuild` from `@bedrock-core/builder/runner` accepts named stage functions and `validateArtifacts`.
The bundler loads only when selected; other unimplemented stages fail before plugin execution.
Default validation checks registered
files; it does not validate Minecraft schemas or establish runtime compatibility.

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
development folder for behavior/resource packs. Deployment into Minecraft directories is pending.
Other module types remain exportable with no inferred behavior/resource destination.

Profiles explicitly select built-in stages. An absent stage is disabled. A bundler-only project
does not enable guides, translations, UI compilation or the server framework. A complete stack
will be an explicit preset. Installed npm dependencies and selected build stages are separate.

The intended distribution separates the runner, independently installable stage packages and
a convenience stack preset. A shared plugin contract has no Minecraft runtime dependency.
Standalone stage functions accept explicit inputs and return artifacts; builder adapters schedule
them. `packages/bundler` implements this boundary; other stage packages remain pending.

| Component   | Build-time purpose                                | Standalone boundary                                                         |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Runner      | Configuration, scheduling, staging and export     | No server/UI runtime required                                               |
| Manifest    | Resolve pack manifest input                       | Explicit manifest inputs and outputs                                        |
| Generator   | Execute typed content templates                   | Template dependencies only                                                  |
| Bundler     | Compile an explicit TS/JS entry                   | esbuild only; screen JSX integration is pending                             |
| i18n        | Generate language files and translation artifacts | Runtime translation helpers only when code uses them                        |
| Guides      | Compile guide content                             | MDX tooling; translations and guide runtime when content requires them      |
| UI compiler | Compile screen modules into pack assets           | UI compiler libraries; runtime registration dependencies for generated code |

These are extraction targets, not guarantees about the current Regolith filters. Runtime apps
such as config, catalog and guides have their own dependencies; changing the builder does not
remove those. Document each extracted package's direct dependencies, consumed/provided artifact
IDs, optional integrations and runtime requirements. Declare unconditional prerequisites and
conditional requirements based on selected features; fail with the missing artifact and its
provider or external-input option. Never silently enable the entire stack.

Raw JSON imports need no translation or guide stage. Generated imports require either a selected
producer or an explicitly configured existing artifact. Import resolution must not use stale
generated files from a previous build. Validation of these dependencies is not yet implemented.

## Extension vocabulary

A plugin supplies a module; a step invokes it with JSON settings at one boundary. Built-in stages
run in stable order. Hooks targeting absent or disabled stages fail. Modifying hooks run before
final validation and export. Plugins execute as trusted Node code.

## Bundler settings

Select `bundler` with an `entry` relative to config.json. It writes behavior-pack `scripts/main.js`
unless `outfile` selects another pack-relative `.js` destination. `debug`, `target`, `tsconfig`,
`external` and `generatedImports` are validated by the package schema. `generatedImports` maps
specifiers to artifact IDs registered by earlier steps. Ordinary JSON imports need no producer.
With one behavior pack, the manifest determines the destination automatically. With several,
set `bundler.pack` to its configured name. Other scripts are retained; occupied output paths fail.
See [the package](packages/bundler/README.md)
for standalone use and limits.

```sh
node bin/build.ts examples/script-only/config.json
```

The workspace-root PLAN.md owns delivery order and acceptance criteria.
