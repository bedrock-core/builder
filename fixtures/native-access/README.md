# Native access acceptance

Acceptance fixtures for production native lookup instrumentation and reference
transport. Builder selects tracing from public SDK contracts and shares the
server runtime's provenance tracker with authored code and dependencies.

`authored.ts` uses ordinary `@minecraft/server` calls and returns native objects.
`packages/bundler/src/native-access-transform.ts` identifies native results with
the native TypeScript compiler. The fixture's `transform.ts` provides a reference
transform for saved-source comparisons. Ordinary
data and entity, dimension and block identity lookups retain direct native code.
`runtime.ts` reexports the server runtime tracker, which stores compact parent links
in a WeakMap and creates recipe arrays
only when encoding. The receiver resolves an identity root and repeats permitted
lookups. Returned objects and their native prototypes are preserved.

Contiguous non-optional inventory chains capture the final slot in one operation.
Every native component, container and slot lookup still executes. A bounded cache
reuses immutable recipe fragments for integer slot indices 0–63; larger valid
indices use fresh provenance. No native handle is cached by this optimization.
Literal arguments and immutable parameters in strict single-return functions can
be passed directly. Mutable expressions retain deferred evaluation after the
native method read. Other chains use the individual-operation tracker.

The inventory path is an entity identity followed by `getComponent`, `container`
and `getSlot`, with evaluated arguments. Entity creation is represented by the
created entity's identity; spawning and other mutations never become replay steps.
The decoder validates the complete lookup path before executing it.

## Run

From the Builder repository, use dependencies installed in `fixtures/acceptance`
or select an existing toolkit project explicitly:

```powershell
$env:BUILDER_ACCEPTANCE_DEPENDENCY_ROOT = 'C:/path/to/toolkit-project'
node --test test/native-access.test.js
node scripts/native-access-prototype.mjs --build-only
```

`--build-only` checks the fixture and builds provider/consumer packs with installed
dependencies, including warm reuse, without starting BDS. The dependency input
graph comes from esbuild's runtime resolution, so JavaScript implementations behind
separate declaration files participate in instrumentation.

To run headless GameTests through the existing runner:

```powershell
$env:BUILDER_BDS_RUNNER = 'C:/tools/bds-runner/bin/bc-bds.mjs'
node scripts/native-access-prototype.mjs --native
node scripts/native-access-prototype.mjs --native --suite lifetime
```

Set `BC_BDS_PATH` to use a specific existing BDS executable directory. Otherwise,
the runner uses the repository's server home described below.

The driver checks original and instrumented TypeScript, builds isolated provider
and consumer packs through Builder, verifies warm reuse, and runs headless BDS
GameTests through the existing runner. The fixture carries recipe JSON through
the existing public addon API. Native-signature integration into the public API
compiler is not enabled by this experiment.

Outputs are in `.bedrock-core/native-access/`: `report.json`, `result.json`,
`native.log` and `authored.instrumented.ts`.
The report includes source hashes. `--fixture <directory>` selects a saved fixture
and its transform; `--output <directory>` isolates its results for matched runs.
The lifetime suite writes separately to `.bedrock-core/native-access/lifetime/`.

Both suites reuse `.bds/` as their server home,
independent of `--output`. Set `BC_BDS_HOME` to choose another fixed server home.
Run these suites sequentially. Windows firewall rules match the executable path,
so keeping the server home fixed lets runs reuse its existing approval.

## Coverage

Offline checks cover real object identity, private receiver state, named and
namespace import aliases, flat property destructuring, bound, rebound and borrowed
methods, structural aliases and parameters, optional and parenthesized calls,
ordinary callback flow, a native spawn callback, local and installed TypeScript
helpers, argument evaluation, forwarding, missing owners and invalid lookup paths.
The source and generated TypeScript are checked independently.

JavaScript dependency coverage includes ESM, CommonJS, private helper modules,
optional and parenthesized calls, bound methods and flat inventory destructuring.
Public declarations type the caller; erased implementation lookups use the runtime's existing native
owner checks. Unrelated lookalikes retain normal receivers, argument evaluation,
assignments, updates and deletion. CommonJS directive prologues and module format
are preserved. Installed-package builds use one tracker across provider and
dependency code.

The fake engine also checks block inventory replacement and forwarding a container
lookup into a third realm under both permanently invalidated and location-following
native lifetimes. A new decode finds the current inventory; tracing does not impose
a lifetime on retained handles. Local inventory handles without captured provenance
reject transfer. These offline checks model the lookup contract and do not establish
Minecraft behavior.

Optional chains retain null checks, receivers and skipped arguments. Erased
lookups use explicit operation rules and an already captured receiver origin;
untracked lookalikes cannot invent a lookup path. Pack code and installed helpers
share one tracker module within each addon.

Native checks verify real `ContainerSlot` handles in separate addons, writes to
the same inventory, forwarding, owner removal and one entity creation regardless
of reconstruction count. The lookup suite includes installed ESM and CommonJS
helpers. Projected item snapshots remain ordinary data. Raw
`ItemStack` snapshots reject reference encoding; they need a value codec.

The lifetime suite checks untracked local inputs, native component owner fields,
block inventory replacement, lookup forwarding, Core shutdown and entity removal.
Retained containers and slots keep the engine's validity rules. Block replacement
does not guarantee whether a retained handle becomes valid again. Resolving a
captured block lookup reacquires the current inventory independently of that handle.
Minecraft-owned handles remain independent of Core registration. A spawn callback
checks entity validity before accessing components because removal can precede
callback delivery.

Arbitrary dynamic member names, replaced native methods and nested or rest native
destructuring are outside this fixture. Erased JavaScript inference is limited to
the permitted inventory lookup members; other unconstrained `any` operations are
unsupported. An untracked non-root handle rejects encoding. Native public API
signatures and owner lifetime beyond the verified inventory path require
production integration.

## Performance

Both benchmarks alternate direct and instrumented runs with warmup and seven
samples per case. Native samples time 2,000 inventory lookup chains inside the
provider, excluding RPC wait time. The report retains medians, ranges and raw
samples, plus added microseconds per chain. The Node benchmark uses a fake native
engine and is reported separately.

The measured workload is repeated native lookup; its ratio is not a whole-addon
or whole-server performance estimate. Production enablement needs an explicit
overhead budget and coverage of the unsupported access patterns.

## Native qualification

Set `BC_BDS_PATH` to the existing approved BDS executable directory to qualify,
then run:

```powershell
$env:BUILDER_BDS_RUNNER = 'C:/tools/bds-runner/bin/bc-bds.mjs'
node scripts/native-access-qualification.mjs --server-dir "$env:BC_BDS_PATH"
```

The driver freezes the production tracker, native transform and fixture, builds provider/consumer packs once and checks warm
reuse. TypeScript, erased ESM and CommonJS each use a matching uninstrumented
control. JavaScript controls are copied from the same installed helper sources
before instrumentation, including the ESM module's private helper.

Each of three independent native processes runs the cross-addon reference checks
before timing. Every variant warms both paths and collects seven alternating
20,000-lookup batches inside the provider. Transport and recipe encoding stay
outside the timer. A variant qualifies only if every run has a direct median of
at least 20 ms and a traced/direct median ratio no greater than 1.5. Functional
GameTest success alone does not satisfy the performance target.

The executable is reused in place. The driver owns a temporary world and its
world-local packs, restores server.properties and checks existing-world hashes
before removing its test world and lock. Results, source and pack hashes, raw
samples, engine/SDK versions and native logs are retained under
`.bedrock-core/native-access-qualification/run-*/`. `qualification.json` records
the verdict; a failed target returns a nonzero exit code. For build-only review,
the prototype driver's `--suite qualification --build-only --retain-packs` keeps
compiled packs in the selected `--output` directory.
