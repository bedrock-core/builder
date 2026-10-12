# @bedrock-core/builder-ui

UI integration for the builder's `ui-compiler` stage. It compiles the project's screens,
links the complete screen set and writes resource assets, host definitions and runtime
registration into staged packs. Its `./plugin` entrypoint exports `run` and `detect`
through the same contract as external plugins. Configure it through builder profiles
or as a module step.

Builder settings accept `owner` and `resourcePack`. The owner's screens and host
definitions are processed together; client assets go to the selected direct local
resource dependency. The sole script pack and sole local resource candidate are
inferred. Ambiguous destinations require an explicit ID. Unrelated packs receive
no generated UI or language output. Standalone APIs retain explicit output paths.

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

Internal bundling helpers accept `sourceOverrides`, mapping absolute source paths to
editor-buffer text. Screen transforms and imported helpers consume those buffers without
writing authored files. Bundles with overrides disable compilation-cache reuse.

## Stage options

The package exports `UiSettings` for typed stage configuration:

```ts
import type { UiSettings } from '@bedrock-core/builder-ui';

const settings: UiSettings = { testMetadata: true, pretty: { indent: 'tab' } };
```

When the guides stage is active, generated guide screens share the installed guide factories
with the UI toolkit. The UI plugin owns runtime registration and contributes its screen
JSX transformation to bundling through the shared extension interface.

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

## Navigation metadata

Runtime registration includes every compiled screen key and its host kind, including
native block/entity screens. Action and modal screens can export a `parameters` contract
from their screen module. Screen collections export contracts keyed by the same member names.
The addon's installed UI runtime validates those contracts during compilation.

```ts
import type { ScreenParameters } from '@bedrock-core/ui/navigation';

export const parameters = {
  itemId: { type: 'string' },
  section: { type: 'string', optional: true },
} as const satisfies ScreenParameters;
```

A nonempty public contract retains the component so its values and handlers can be rebuilt
from the inputs. Static references accept no parameters. Generated `SCREEN_KEYS` and editor
declarations include container hosts for discovery; they do not create a native container session.
