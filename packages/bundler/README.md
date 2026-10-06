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

The builder adapter requires `entry`, defaults `outfile` to behavior-pack `scripts/main.js`, maps
the destination from the sole behavior manifest or an explicit `pack` name, maps
`generatedImports` specifiers to registered artifact IDs, and registers bundle/map artifacts.
Occupied output paths fail rather than replacing another step's script. Consumed TS inputs inside
the destination pack are removed from staging after compilation; authored source files remain
unchanged. Other pack files are preserved.

Screen JSX transforms, JSON5 support and Regolith parity remain pending. `.screen.tsx` modules
fail explicitly until UI transformation is integrated. The default `es2020` compilation target
does not establish Minecraft runtime compatibility.
