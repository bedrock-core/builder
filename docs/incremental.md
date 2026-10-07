# Automatic compilation reuse

`@bedrock-core/builder` checks each compiled TS/JS entry before invoking its compiler.
An unchanged source, import graph and compiler configuration reuse the stored result during
both build and watch. Addon projects need no cache IDs, dependency lists or registration code.

## What rebuilds

| Change | Work performed |
| --- | --- |
| A script entry changes | Compile that entry and retain unrelated entries |
| An imported helper or JSON file changes | Compile its consuming entries |
| A resource asset changes | Export the asset and reuse unrelated compiled scripts |
| A template produces different JSON | Compile scripts that import that JSON |
| A template runs and produces identical JSON | Reuse its consuming script bundles |
| A resolver candidate appears | Recheck entries whose import may resolve differently |
| Compiler options or an inherited config change | Compile entries that use that configuration |
| An installed package input changes | Compile entries that import that package input |
| A screen or its imported helper changes | Compile its consuming screen modules and render those screens |
| A script or unrelated asset changes | Reuse unchanged screen modules and rendered screens |
| A UI compiler/runtime input changes | Rebuild the shared toolkit and render screens whose compiler bundle changed |
| A screen is added or removed | Link the current set and replace generated UI outputs |
| A guide page changes | Compile that locale page and reuse unrelated guide pages |
| A guide category or page set changes | Assemble navigation and validate links without reparsing unchanged pages |
| A guide texture changes or appears | Recompile pages that use that texture |

Tracking includes transitive imports, package resolution metadata, missing resolver candidates,
tsconfig path mappings, JSONC configs and inherited configuration files. Content fingerprints
ignore timestamp-only changes. Compiler and Node versions participate in invalidation.

Each manifest script entry is a bundle boundary. Each template and locale module has its own
compiled module record. Deleting a template removes its output from the next staged pack.
Cached source maps are restored with paths relative to the current temporary workspace.

## Compilation and execution

Reusing compiled JavaScript does not freeze runtime Node behavior. Templates that read the
filesystem or environment, perform side effects, or call runtime functions still evaluate on
every build using a fresh module instance. Locale modules also evaluate freshly. Their compiled
code is reused while their compiler inputs remain unchanged.

Data-only templates can reuse their generated documents as well. Plain default-exported objects,
relative data imports and simple Many callbacks are recognized automatically. Restored documents
still pass validation and artifact registration. Plugin hooks execute each build. Runtime file
reads in templates and plugins need plugin dependencies or profile watch paths to trigger watch;
the compiler can automatically discover static imports.

## Controls and diagnostics

Caching is enabled by default. Set `"cache": false` on a profile to compile without reuse, or
remove `.bedrock-core/cache/build` to clear persisted compiled results. Cache records are saved
only after a successful build and export. Invalid records rebuild from source.
The cache index references separately stored compilation records, keeping large screen sets
out of a single JSON document. Unchanged records remain on disk without rewriting their values.

`BuildResult.compilations` reports the current build's compiled-file and generated-output cache
checks as `executed` or `cached`. Generator records prefixed with `compiled:` describe compiled
JavaScript; its other records describe output evaluation. Generator stage logs count compilation
and template evaluation separately.

UI `module:` records describe source compilation; `screen:` records describe rendering. The
toolkit has one shared `library` record. UI caches store unlinked screen data, so linking always
uses the complete current screen set. Routers, hook merges, language sections, container hosts,
runtime registrations and test metadata remain complete on cache hits. Formatting and build
stamps apply to output without rerendering screens. Locale content participates in rendering
invalidation. Screens with Node I/O or ambient values evaluate freshly while reusing their
unchanged compiled modules. Runtime external file reads need profile watch paths to trigger watch.

Guides `page:` records contain parsed page IR and localization entries. Their cached diagnostics
are replayed and internal links are checked against the current default page set. Categories,
operator access, navigation and translated link text are assembled each build. Generated guide
screens import the complete manifest, and UI text measurement uses locale tables; edits to
those inputs can invalidate downstream screen compilation while guide page parsing stays selective.

The runner continues to stage and export complete packs. Final validation and publication run
on cache hits. Measure UI compilation with the isolated fixture harness:

```sh
yarn node scripts/benchmark-ui.ts path/to/fixture-project path/to/project-with-node_modules
```

The fixture project must contain `packs/BP` and `packs/RP`. An optional third argument limits
the screen count for a harness check. The command copies inputs into a temporary project and
measures the UI stage with complete staging, manifest validation and export. It checks an
unchanged build and a single-screen edit against the cold output's UI byte fingerprints.
Language files and the test metadata sidecar must also retain their byte fingerprints.
Fixture harness script bundling is excluded from these measurements.
