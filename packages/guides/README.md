# @bedrock-core/builder-guides

Compiles Markdown and MDX guides into the manifest consumed by `@bedrock-core/guides`, localized
language sections and generated screen modules. This private workspace runs typed TypeScript
directly on Node 22.18 or newer.

## Standalone API

```ts
import { compileGuides } from '@bedrock-core/builder-guides';

const result = await compileGuides({
  root: '/path/to/project',
  namespace: 'creator_pack',
  packs: [
    { path: 'packs/logic', kind: 'behavior' },
    { path: 'packs/assets', kind: 'resource' },
  ],
});
```

`root` resolves authored paths. `sourceDir` defaults to `guides`; locale directories contain
`.md`/`.mdx` pages and `_category_.json` categories. `defaultLocale` defaults to `en_US` and
defines structure, navigation and fallback strings. `result` reports the typed manifest,
written files, declarations, inputs and diagnostics. Missing content is a no-op.

The default manifest and declarations go under `.bedrock-core/generated/guides`. Screen modules
go under the first behavior pack's `scripts/guides`. Language sections and `languages.json` go
to every supplied resource pack. Set `compileScreens: false` for a content-only build; it needs
a resource pack but no behavior pack or installed guide/UI runtime. Generated screen files
carry an ownership header; repeat calls replace their contents and remove obsolete owned
screens without deleting authored files. Use the builder when coordinated staging and export
are required.

`compileGuidePage`, `assembleLocale` and `buildManifest` expose pure compilation and assembly
for tools that manage their own I/O. `@bedrock-core/builder-guides/screens` exposes screen
module generation. These APIs use remark, unified, YAML and Markdown utilities; no builder,
Minecraft server, translation runtime or UI runtime is imported by the compiler itself.

## Authoring

```text
guides/
  en_US/
    intro.mdx
    getting-started/
      _category_.json
      installation.mdx
  es_ES/
    intro.mdx
```

Titles, headings and prose retain structural localization keys. Translated pages supply
values; missing keys fall back to the default locale, extra keys are dropped and drift warns.
`strictLocales: true` fails on drift. Paragraphs and list items with internal links carry
tagged strings per locale in the manifest. Broken internal links fail compilation.

Frontmatter supports `title`, `sidebar_position`, `hidden`, `icon`, `description`, `home` and
`access: op`. Categories support `label`, `position`, `collapsed`, `link`, `icon` and `access`.
Operator access inherits downward, produces a separate screen set and preserves both
navigation chains. Blocks include headings, paragraphs, lists, admonitions, code, images,
horizontal rules and literal MDX components. PNG dimensions are read from supplied resource
packs. Code is wrapped by UTF-8 byte length; `maxCodeLineBytes` defaults to 60.

MDX imports, exports and expressions are skipped with warnings. They are never executed.
`componentsModule` names a project-relative module default-exporting a component registry;
the downstream UI stage compiles that module and its imports. Tables, footnotes, inline images
and raw HTML retain the guide compiler's unsupported-content behavior.

## Builder integration

The guides stage detects `guides/**/*.md` and `.mdx` automatically. Options live in
`bedrockCore.profiles.<name>.stages.guides` and are validated by
[`schemas/guides.schema.json`](../../schemas/guides.schema.json). Set `guides: false` to disable it.
The project namespace supplies localization names; no namespace scan or authored data directory
is required. A configured `sourceDir` selects an alternative content root.

`owner` selects the script pack receiving generated screens; `resourcePack` selects
its direct local resource dependency for guide strings. The sole script pack and sole
local resource candidate are inferred. Multiple candidates require explicit IDs.
Resource-only content builds select their resource owner and `compileScreens: false`.
Standalone callers supply pack paths and can choose an explicit `screensDir`.

| Provided artifact | Consumer |
| --- | --- |
| `guides:manifest`, imported as `@bedrock-core/generated/guides` | Script bundler and custom build steps |
| `guides:<pack>:texts/<locale>.lang` | i18n passthrough and UI text measurement |
| `guides:<pack>:scripts/guides/<screen>.screen.tsx` | Automatic UI screen discovery |
| `.bedrock-core/generated/guides/guides.generated.d.ts` | Editor types for the generated import |

Add `.bedrock-core/generated/guides/**/*.d.ts` to the project's TypeScript `include`.
The declaration uses `@bedrock-core/builder-guides/types`, which has no runtime or Markdown
dependencies. Its manifest shape matches the guide runtime contract; content-only projects
can typecheck their generated import without installing the guide/UI runtime stack.

Compiled screens require the addon's installed `@bedrock-core/guides`, UI toolkit and their
declared peers. The UI toolkit bundle shares the installed guide factories across screens;
unchanged builds reuse both guide page compilations and rendered screens. i18n detects generated pack language files, collects guide text into its
runtime bundle and discovers installed libraries' translations even without authored locale
modules. Generated aliases are registered automatically; the builder stages run guides,
i18n, UI and bundling in that order.

Each locale page has its own compilation cache record. Page source and referenced texture
files participate in reuse. Link validity, category labels, navigation, locale reconciliation
and screen modules are assembled from current inputs every build. Editing a category or adding
a page does not reparse unrelated pages. Guide screen modules import the complete manifest;
manifest and locale changes can invalidate downstream UI compilation. Profile `cache: false`
disables page reuse. Final validation and export always run.
