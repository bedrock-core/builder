# @bedrock-core/builder-manifest

Manifest processing owned by a build plugin. The `./plugin` entrypoint exports
`detect` and `run` using the shared `@bedrock-core/builder-plugin` contract.
It resolves profile-selected manifest inheritance in staging, writes each complete
manifest and removes pack-root manifest variants before export. Inputs are tracked
and each output is registered as `manifest:<packId>`.

```ts
import { resolveManifest } from '@bedrock-core/builder-manifest';

const result = await resolveManifest('./packs/BP/manifest.test.json', {
  root: process.cwd(),
});
```

The standalone entrypoint exposes explicit manifest transformations, inheritance
resolution, script-entry reading and final identity/file validation. Objects merge
recursively; child arrays and scalars replace their parents. Inheritance must stay
inside the supplied project root. Missing inputs, cycles, invalid manifest v3
fields, duplicate identities and invalid compiled script entries fail.

The package requires Node 22.18+ and the shared plugin contract. Manifest processing
reads and writes JSON without executing a script compiler or Minecraft runtime. `@bedrock-core/builder/manifest` exposes
the same standalone API through the builder package.
