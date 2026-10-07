# @bedrock-core/builder-ui

Typed Node build integration for the addon's installed UI toolkit. The runner uses these
functions to compile screens, link their current set and write staged pack assets. Calling
them directly requires no builder configuration, generator, guides or server framework.

## Dependencies

| Component | Requirement |
| --- | --- |
| Adapter | Node 22.18+, esbuild, TypeScript and the shared bundler dependency tracker |
| Addon compiler | Installed `@bedrock-core/ui-compiler`, matching `@bedrock-core/ui-runtime` and `@bedrock-core/ui` |
| Translations | The toolkit's `@bedrock-core/i18n` runtime; a generated translation bundle is optional |
| Game modules | Installed game type declarations used to construct build-time stubs |
| Framework/apps | Required only by components or declarations that import them |
| Pack output | Resource packs for UI assets; owning behavior packs for container hosts |

Toolkit packages resolve from the addon. Shared imports use the addon's package instances so
hooks, compilation and translations agree across linked packages. The adapter consumes the
compiler's JSON UI documents, hooks and runtime contract without reimplementing layout.

## Standalone API

`bundleUiLibrary()` builds the shared toolkit. Write its `code` to `library.mjs` in a temporary
directory. Create `UiEvaluator({ library })` and request `exports` to obtain its namespace map.
Pass that map to `bundleUiModule()` for each source, then write the resulting modules alongside
`library.mjs`. Both bundle functions return their static dependency inputs.

Request `screen` with a module path, name and namespace to render a default component. For a
default-exported screen record, request `list` first and provide each selected `member`.
Request `link` with the complete screen set and namespace. Always close the evaluator in a
`finally` block. Its workers recycle to bound module memory.

`writeUiResource()` writes linked screens, shared faces, support documents, routers, hook
merges, language sections and optional metadata to one resource pack. `writeUiHosts()` resolves
container hosts across behavior packs and writes their definitions and protocol items.
`uiRegistration()` produces runtime registration source for the linked set.

`bundleUiDeclaration()`, `readUiDeclaration()`, `declaredApps()` and `declaredScreens()` support
tagged app declarations and app-owned shape functions. Declarations evaluate freshly in a
worker; the game and generated UI imports are stubbed while the registration is captured.
The `./transform` export supplies the conditional JSX transform used by both compilation
and script bundling.

## Builder artifacts

| Direction | Artifact |
| --- | --- |
| Optional input | `@bedrock-core/generated/i18n` resolves from the producer's registered runtime bundle |
| Runtime output | `ui:bundle`, imported as `@bedrock-core/generated/ui` |
| Pack output | `ui:<packId>:<relative-path>` for generated or modified pack files |
| Editor output | `.bedrock-core/generated/ui/screens.generated.d.ts` |

The builder automatically tracks compilation and rendering inputs. Addons do not register
cache tasks or dependency graphs. A changed helper invalidates its consuming screens, while
script-only changes reuse their rendered output. Linking and writing pack outputs run on
each build. The runner then validates and publishes complete packs.

These workspace packages are private. Distribution and publication remain separate work.
