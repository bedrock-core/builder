# @bedrock-core/builder-generator

Generate JSON from typed templates without the runner or Minecraft runtime framework.
This private workspace package uses `@bedrock-core/builder-bundler` and esbuild to compile
trusted templates for Node. Templates can import project TS/JS, JSON, installed packages
and Node built-ins. Generated JSON has no runtime package dependency.

## Templates

A single document is a plain default-exported object. `satisfies` selects its Minecraft type
without adding a runtime helper:

```ts
export default {
  'format_version': '1.21.0',
  'minecraft:entity': {
    description: { identifier: 'example:training_dummy', is_summonable: true },
    components: { 'minecraft:health': { value: 20, max: 20 } },
  },
} satisfies Entity;
```

`training_dummy.entity.ts` emits `training_dummy.entity.json` beside itself. An untyped
`export default { enabled: true }` also works. File and folder names do not select a schema.
To emit several documents, export a `[nameFn, dataFn, items]` tuple:

```ts
type Options = { id: string; item: string };

export default [
  option => option.id,
  option => ({ pools: [{ rolls: 1, entries: [{ type: 'item', name: option.item }] }] }),
  [{ id: 'apple', item: 'minecraft:apple' }, { id: 'bread', item: 'minecraft:bread' }],
] satisfies Many<Options, LootTable>;
```

This emits `apple.json` and `bread.json` in the template's directory. Name and data callbacks
can be async. Names must be portable basenames; `.json` is appended when absent. Templates can
import helpers and JSON, run Node code, and await computations before exporting the resulting
object or tuple. Shared modules can live outside packs or be excluded from template discovery.
Each selected source must have its own output default export.

`defineTemplate(data)` and `defineMany(name, data, items)` are optional, automatically available
helpers. Category forms such as `defineTemplate('bp/items', data)` and
`defineMany('bp/loot_tables', name, data, items)` supply schema typing and non-enumerable metadata.
The standalone validation callback receives `document.category`; metadata does not enter JSON.
A plain `satisfies Entity` expression is erased and supplies no runtime tag.

Runtime injection uses module bindings inside each compiled template and respects local bindings.
Explicit imports from `@bedrock-core/builder-generator/templates` work in shared modules; this
entry contains only typed helpers and does not load compilation dependencies. If templates use
automatic helpers, declare their names as readonly ESLint globals.

## Minecraft editor types

The builder stage generates declarations by default from Mojang's
[`@minecraft/bedrock-schemas`](https://github.com/Mojang/bedrock-schemas) catalog. Run the build
once, then include the generated global declarations alongside authored files in tsconfig:

```json
{
  "include": [".bedrock-core/generated/mc/globals.d.ts", "packs/**/*.ts", "shared/**/*.ts"]
}
```

Preserve other existing include patterns. Global aliases include `Entity`, `Block` and
`LootTable`, plus `Many<T, Document>` for typed callbacks. Collisions use pack prefixes, such
as `BpAnimation` and `RpEntity`. `typePrefix: "Mc"` produces `McEntity` and `McMany` instead.
Small types used once are inlined, including simple records, arrays, unions and interfaces.
Matching shapes share a declaration. Complex, recursive and public document types keep their
names. Field documentation is retained, and generated declarations use two-space indentation.
Incomplete or contradictory schema shapes use `unknown`.

`types: false` disables declaration generation and schema downloads. `schemaVersion` defaults
to `latest`; pin an exact package version for reproducible schema inputs. `maxAgeHours` controls
registry metadata caching and defaults to 24. Cached exact versions work without registry access.
`typesDir` selects a dedicated project-relative output directory; null or omission uses
`.bedrock-core/generated/mc`. The schema cache lives in `.bedrock-core/cache/generator`.
Ignore `.bedrock-core` in version control. Custom declaration directories must also be ignored.

`strict` defaults to false, allowing properties the upstream schemas may not yet describe.
TypeScript checks authored templates separately from the build; the generator does not run the
typechecker or validate Minecraft content at runtime.

## Standalone API

```ts
import { generateTemplates } from '@bedrock-core/builder-generator';

const result = await generateTemplates({
  root: '/absolute/path/to/staging',
  files: ['packs/gameplay/items/item.ts'],
  dependencyRoot: '/absolute/path/to/authored-project',
  pretty: { indent: 'space', size: 2 },
  validate(document) {
    // Apply a project-specific schema validator to document.value.
  },
});
```

The function writes JSON beside selected templates and leaves sources intact. Existing JSON
files are replaced; repeated output names retain the last emitted document. Explicit input files
are deduplicated and evaluated in path order. All templates and validation callbacks complete
before writing. Failed writes or cancellation restore replaced files and remove new files written
by that call. Results contain documents, templates and compiler input paths for watching. Use a
staged directory when authored JSON must remain unchanged.

`tsconfig` selects a project-relative compiler config. `aliases` maps import specifiers to existing
files, including external generated inputs. `dependencyRoot` supplies the authored project's npm
installation when compiling a staged copy. `pretty: false` or omission emits minified JSON; an
object selects indentation. `signal` provides cooperative cancellation at compilation and document
boundaries. Cancellation cannot interrupt synchronous template execution or an unresolved promise.

Serialization follows `JSON.stringify`: undefined object fields are omitted, and BigInt or circular
references fail. Single exports must be objects; array exports must be the three-part tuple.
Compiler inputs track static imports; runtime filesystem reads must be declared separately through
builder plugin dependencies or profile watch paths. Each template gets a fresh compiled module per
invocation so import edits are visible on subsequent builds.

`generateTemplates` performs no declaration generation. Call
`generateSchemaTypes({ root, schemaVersion, typesDir, typePrefix, strict, maxAgeHours })` separately
to prepare editor types; it returns the resolved schema version, output path and whether declarations
changed. Unchanged declarations retain their timestamps. The function replaces only an owned
declaration directory and retains its previous contents on compilation failure. Type generation uses
`json-schema-to-typescript`, TypeScript's syntax tools and official schema data; the declarations
require neither the runner nor the Minecraft runtime framework.

## Builder adapter

Enable `generator: true` or a settings object in a profile. Default discovery includes `.ts`
sources under every configured pack, excluding pack `scripts` directories and declaration files.
`include` and `exclude` accept a string or array of project-relative glob patterns; selected
templates must remain inside configured packs. The adapter removes consumed template sources only
from staging and registers every JSON document as `generator:<packId>:<packRelativePath>`.

`generatedImports` maps specifiers to artifact IDs from earlier stages or hooks. For example,
`{ "@bedrock-core/generated/input": "my-input" }` consumes a registered `my-input` file.
Later stages can consume the generator's artifact IDs or ordinary relative JSON imports.
Settings are described by [the schema](../../schemas/generator.schema.json).

The adapter prepares editor declarations in the authored project and generates pack JSON only
in staging. Type directories are excluded from watch inputs. This private native-TS package
requires Node 22.18 or later; publishing requires a JavaScript distribution with declarations.
