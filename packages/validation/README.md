# @bedrock-core/builder-validation

Validate pack JSON against Mojang's versioned schema catalog without the builder,
TypeScript bundler or framework runtime. The package uses `@minecraft/bedrock-schemas`,
Ajv, jsonc-parser and picomatch. It writes no files and executes no addon code.

```ts
import { validatePackContent } from '@bedrock-core/builder-validation';

const result = await validatePackContent({
  packs: [{ id: 'gameplay', path: '/project/packs/BP', kind: 'behavior' }],
});
```

Every `.json` document receives syntax checks, with comments and trailing commas
accepted. The pack kind selects behavior or resource schemas; catalog glob patterns
select document categories. More specific filenames take precedence over folder patterns.
Relative references resolve within the schema package. Symlinked content and references
outside the schema package are rejected. Manifest identity and script-entry checks belong
to `@bedrock-core/builder/manifest`.

`ContentValidationError.diagnostics` contains the pack ID, relative file, JSON pointer
and message. The builder applies these checks after all hooks and before export,
automatically reusing unchanged file and schema inputs.

The result records the schema package version and coverage for every file. Documents
without a catalog match receive syntax checks. An unavailable upstream schema also
receives syntax checks and an explicit `schemaIssue`; it does not count as schema-validated.
`texts/languages.json` uses the documented locale-array shape. JSON UI schemas in Mojang's
catalog are shallow, so successful checks do not establish binding, layout or client behavior.
Textures, audio, structures, Molang semantics and external pack references need Minecraft
acceptance checks.

`schemaRoot` can point to another installed schema package containing `catalog.json`,
`package.json` and `schemas/`. `signal` supports cancellation. The `reuse` callback is an
optional integration boundary for host caches; ordinary callers need no cache setup.

Sources: [Mojang catalog](https://github.com/Mojang/bedrock-schemas),
[Microsoft schema reference](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/schemasreference/schemaslist),
[language catalog format](https://wiki.bedrock.dev/text/text-intro).
