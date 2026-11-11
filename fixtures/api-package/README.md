# Portable addon API acceptance

Provider builds emit JavaScript clients and TypeScript declarations through the
normal bundler stage. Acceptance packs each emitted package and checks installed
plain esbuild consumers and Builder consumers without access to provider source.

The package contains explicit exports, client entries, reachable public
declarations, shared value implementations and owner manifest metadata. Provider
functions, storage and class-backed object implementations stay in the behavior
pack. Intentionally shared value classes and codecs are executable public code.
Compatible API packages and Core registration share installed runtime modules;
runtime copies are not embedded independently in each package.

## Consumer behavior

Bundle the API and its runtime dependencies. Keep native `@minecraft/*` modules
external and declare the provider BP UUID/version in the native manifest. No Core
registration is needed. First use starts one shared API-only Sync endpoint; a
registered Core connection takes priority. Standalone bundles exclude addon
registration, persistence, translations and host election. Shared-value imports
resolve without Minecraft or transport initialization.

Late Core registration routes new calls through Core. Pending calls and their
callbacks finish on the API-only endpoint within existing deadlines, then that
endpoint stops. Retained class-backed handles preserve identity, forwarding,
state and signal subscriptions across registration. Provider disposal or
replacement still invalidates handles. Providing new API objects or public exports
requires Core registration.

Builder consumes explicit package ownership metadata and ready JavaScript clients.
Its build-time evaluators use engine-free entries through the
`bedrock-core-build` export condition. Public type-only subpaths remain type-only,
and required ambient declaration dependencies are included.

## Run

From the Builder repository with matching fixture dependencies installed. To use
an existing dependency installation, select its project explicitly:

```powershell
$env:BUILDER_ACCEPTANCE_DEPENDENCY_ROOT = 'C:/path/to/installed-project'
node scripts/api-package-acceptance.mjs
```

For native acceptance, select the installed runner entrypoint. Server caches,
instances and logs use Builder's own root `.bds/`:

```powershell
$env:BUILDER_BDS_RUNNER = 'C:/tools/bds-runner/bin/bc-bds.mjs'
node scripts/api-package-acceptance.mjs --native
```

Without `--native`, the driver checks automatic provider publication, warm reuse,
strict consumer types, package archives and consumer bundles. It packs emitted API
packages with `npm pack` and unpacks them into an independent consumer installation.
Checks reject provider implementation leakage and verify one shared binding module.

Native acceptance runs four standalone tests, seven registered plain-esbuild tests,
one late-registration test and seven Builder-consumer tests in separate fresh BDS worlds. They cover functions,
errors, undefined arguments, metadata, subpaths, custom values, callbacks, state,
signals, native handles, provider-owned API objects, late Core handover and missing optional providers.

Archives, bundle metadata, compiled consumers, native results and `report.json`
live in `.bedrock-core/api-package/`. Bundle sizes include acceptance test code and
are not isolated runtime-size measurements. Native lookup-provenance instrumentation
is separate and is not enabled by API package publication.
