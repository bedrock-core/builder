# @bedrock-core/builder-bundler

Standalone script bundling with esbuild and TypeScript config parsing. Requires no builder runner, server framework, guides,
i18n or UI runtime. This private package runs typed TS directly in Node; npm distribution will
require JavaScript output because Node does not strip TS inside node_modules.

```ts
import { bundleScripts } from '@bedrock-core/builder-bundler';
await bundleScripts({
  root: process.cwd(),
  entry: './src/main.ts',
  outfile: './dist/main.js',
  debug: true,
});
```

Paths resolve relative to `root`. Output is bundled ESM; `@minecraft/*` imports stay external.
Debug output includes an external source map. JSON and JS imports use esbuild loaders. Compilation
finishes before output writes. The standalone API replaces its declared bundle/map files; it does
not stage files or provide transactional export. Other files remain intact.

`dependencyRoot` supplies the original project's npm installation for staged sources. Staged
resolution runs first, preserving tsconfig aliases. `resolveFromProject` lists import prefixes
that resolve from `dependencyRoot` first, allowing linked packages to share the addon's instances.
`aliases` maps exact generated imports to
files; missing `@bedrock-core/generated/*` imports report a missing producer. The result contains
output paths, input dependencies, resolution candidates (`watchFiles`), a conservative
`cacheable` flag and esbuild metadata. Cancellation accepts an AbortSignal.
Standalone Node consumers can select `platform: 'node'` and a JavaScript `banner` for runtime
setup. The generator uses these options to support Node built-ins in bundled CommonJS modules.
`inject` supplies helper modules for free identifiers during compilation.
The Bedrock adapter keeps the default neutral platform.

The builder adapter activates automatically for script modules in staged behavior-pack manifests. The
manifest's JavaScript entry selects the same-stem TypeScript source, or the JavaScript file
itself. Manifest plugins can select test scripts before bundling. No script entry or destination
is repeated in builder configuration. Producer import names resolve automatically;
`generatedImports` optionally overrides them or maps custom specifiers to artifact IDs.
Artifacts include the pack ID and manifest entry. All bundles finish before staged scripts
are replaced and consumed TypeScript sources are removed. Authored files remain unchanged.
See [builder settings](../../README.md#bundler-settings) for configuration and validation.

The adapter automatically reuses each compiled entry and restores it into fresh staging.
Unrelated file changes retain cached entries; shared dependencies invalidate their consumers.
Import tracking includes installed package files and metadata, missing resolver candidates,
tsconfig path mappings, inherited configs and JSONC configs. Compiler option changes invalidate
their compiled output. Profile `cache: false` disables reuse. Final pack validation and publication
always run. Standalone `bundleScripts` calls compile each time; the runner manages reuse automatically.

The `./plugin` entrypoint owns manifest-entry discovery, automatic detection and staged output.
The `./entries` entrypoint exposes manifest-to-source selection; `./compile` supplies
`compileModule` for invocation-scoped Node compiler reuse and `compilerFingerprint` for cache keys.

`plugins` accepts feature-owned esbuild plugins. `jsxImportSource` selects automatic JSX runtime
imports. The UI plugin registers its screen transformation and runtime preferences through
`context.registerBundleExtension`; the bundler consumes the shared extension contract.
Custom plugins rebuild by default. Compiler reuse requires `cachePlugins: true`, an appropriate
`pluginKey` and every input in `pluginInputs` or hook `watchFiles`. Directory watches and
virtual inputs without observable files disable reuse.

JSON5 support and broader Regolith parity remain pending. The default `es2020` compilation
target does not establish Minecraft runtime compatibility.
