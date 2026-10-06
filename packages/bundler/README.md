# @bedrock-core/builder-bundler

Standalone script bundling with esbuild. Requires no builder runner, server framework, guides,
i18n or UI runtime. This private package runs typed TS directly in Node; npm distribution will
require JavaScript output because Node does not strip TS inside node_modules.

```ts
import { bundleScripts } from './src/index.ts';
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
resolution runs first, preserving tsconfig aliases. `aliases` maps exact generated imports to
files; missing `@bedrock-core/generated/*` imports report a missing producer. The result contains
output paths, input dependencies and esbuild metadata. Cancellation accepts an AbortSignal.
Standalone Node consumers can select `platform: 'node'` and a JavaScript `banner` for runtime
setup. The generator uses these options to support Node built-ins in bundled CommonJS modules.
`inject` supplies helper modules for free identifiers during compilation.
The Bedrock adapter keeps the default neutral platform.

The builder adapter discovers script modules from every staged behavior-pack manifest. The
manifest's JavaScript entry selects the same-stem TypeScript source, or the JavaScript file
itself. Manifest plugins can select test scripts before bundling. No script entry or destination
is repeated in builder configuration. `generatedImports` maps specifiers to registered artifact
IDs. Artifacts include the pack ID and manifest entry. All bundles finish before staged scripts
are replaced and consumed TypeScript sources are removed. Authored files remain unchanged.
See [builder settings](../../README.md#bundler-settings) for configuration and validation.

Screen JSX transforms, JSON5 support and Regolith parity remain pending. `.screen.tsx` modules
fail explicitly until UI transformation is integrated. The default `es2020` compilation target
does not establish Minecraft runtime compatibility.
