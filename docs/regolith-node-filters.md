# Run Regolith Node filters

Define each Node filter by name and script path under `bedrockCore.plugins`, then
invoke that name in a profile's `steps`. Builder launches the current Node executable
with a conventional Regolith working directory and copies successful pack changes
back into staging. Existing filter entry points run unchanged.

## Run the local example

From the `builder` checkout:

```powershell
corepack yarn build examples/node-filter-project/config.json
Get-Content examples/node-filter-project/build/RP/generated.json
```

The generated document contains `{"name":"Generated resource","value":7}`.
The [example config](../examples/node-filter-project/config.json) uses the
[standalone filter](../examples/node-filter-project/filters/main.cjs).
Watch it with:

```powershell
corepack yarn watch examples/node-filter-project/config.json
```

## Add a filter to a profile

Put the script entry in its named plugin definition and invocation settings in the step:

```json
{
  "bedrockCore": {
    "formatVersion": "1.0.0",
    "plugins": {
      "generate": {
        "script": "./filters/main.cjs",
        "targets": "resource",
        "dataPath": "./packs/data"
      }
    },
    "profiles": {
      "default": {
        "steps": [
          {
            "plugin": "generate",
            "after": "prepare",
            "settings": { "namespace": "my_addon" },
            "arguments": ["extra-argument"]
          }
        ],
        "export": {
          "gameplay": "./build/BP",
          "visuals": "./build/RP"
        }
      }
    }
  }
}
```

Keep the project's metadata and `packs` alongside this section. The example above
assumes configured pack IDs `gameplay` and `visuals` and an existing `packs/data` directory.
For a Regolith definition with `runWith: "nodejs"`, copy its `script` into the named
plugin definition. Copy the invocation's `settings` and `arguments` into its step.
`script` entries always run with Node. Native builder plugins use `module` and
export `run(context, settings)`.

`after: "prepare"` runs before built-in stages. Use `before: "bundler"` for a
filter that produces script inputs, or `before: "export"` for a final pack edit.
Steps at the same boundary run in config order. Disable built-in stages that your
filter already performs; a disabled stage has no hook boundary.

## Options

| Field | Location | Behavior |
| --- | --- | --- |
| `script` | Plugin definition | Required Node entry point; resolves relative to `filterDir`. |
| `targets` | Plugin definition | Run once per matching pack: `resource`, `behavior`, or `both`. Pack types come from manifests. |
| `filterDir` | Plugin definition | Definition directory; resolves relative to config.json and defaults to the project root. Sets `FILTER_DIR`. |
| `dataPath` | Plugin definition | Project directory copied into `data`; defaults to `./data` when it exists, otherwise an empty folder. |
| `packs` | Plugin definition | Optional `{"BP":"gameplay","RP":"visuals"}` map selecting configured pack IDs. |
| `nodeArguments` | Plugin definition | Node flags before the script, such as `--import` or `--require` for an installed loader. |
| `settings` | Step | Nonempty object passed as JSON at `process.argv[2]`. |
| `arguments` | Step | Additional script arguments, following settings. With omitted or empty settings, they start at `process.argv[2]`. |

Definitions and steps are validated by the project's
[config schema](../schemas/config.schema.json), also exported as
`@bedrock-core/builder/schemas/config.schema.json`.

With `targets`, builder classifies each configured pack from its current
[manifest modules](https://learn.microsoft.com/minecraft/creator/reference/content/manifestreference/module?view=minecraft-bedrock-stable).
Pack IDs and directory names can be anything. `targets: "resource"` runs on every
resource pack; `targets: "behavior"` runs on every behavior pack. `targets: "both"`
runs once for each pack of either kind, in the order of the project's `packs` map.
The plugin's target scope is declared; builder determines which packs match it.

Each script invocation sees only its current pack in `RP` or `BP`, according to
manifest type. The other folder is empty. Successful changes return to that same
staged pack. Packs are processed separately. No matching packs means the step is
skipped. A failure on any invocation prevents publication of the entire build.

For example, put this definition under `bedrockCore.plugins` and invoke
`"plugin": "textures"` in a profile step:

```json
{
  "textures": {
    "script": "./filters/textures.cjs",
    "targets": "resource"
  }
}
```

This processes resource packs named `assets`, `icons`, or any other configured ID.
Behavior packs retain their staged contents. The script reads and writes `RP`
normally; it receives `PACK_ID` and `PACK_TYPE` when it needs the current pack's
configured name or type.

Without `targets` or `packs`, current manifest modules select at most one behavior pack for
`BP` and one resource pack for `RP`. Projects with multiple packs of either kind
must select a pair explicitly. Other configured packs keep their staged contents.
An unselected `BP` or `RP` folder is empty; writing pack files there fails the build.
Use `packs` for a script that needs a specific BP/RP pair in one invocation.
`targets` and `packs` are mutually exclusive.

All Node filter steps in a build share the staged `data` directory. Set `dataPath`
on the first invoked plugin's definition; later plugins inherit it or can repeat the same path. Changes are
available to later Node filters in that build. Authored data is preserved and the
temporary data folder is removed when the build ends.

## Run a filter from a sibling checkout

Set `filterDir` to the directory containing its definition and scripts. For example,
from a project in `ui/packages/resource-pack`, this configuration runs the local manifest filter:

```json
{
  "plugins": {
    "manifest": {
      "filterDir": "../../../regolith-filters/manifest",
      "script": "./main.ts"
    }
  },
  "profiles": {
    "default": {
      "steps": [
        {
          "plugin": "manifest",
          "after": "prepare",
          "settings": { "manifestPath": "RP/manifest.json" }
        }
      ]
    }
  }
}
```

Install the filter's npm dependencies before building, using its package manager
in the directory identified by its Regolith `requirements` property, or its script
directory when omitted. Builder runs local installed scripts; downloading
remote filters and dependency installation remain explicit setup steps.

## Execution contract

The filter's cwd contains real `BP`, `RP` and `data` directories. `ROOT_DIR` points
to the authored project containing config.json; `FILTER_DIR` points to its selected
definition directory. The remaining process environment is inherited. Filters
with `targets` also receive `PACK_ID` (configured pack ID) and `PACK_TYPE`
(`resource` or `behavior`). Filters
reading `ROOT_DIR/config.json` see the authored builder config, including any
filter-specific metadata you supply.

Stdout and stderr flow into the build logger. Every invocation runs in a fresh Node
process. Watch registers the script and definition directory as dependencies and
reruns filters when their inputs change.

A nonzero exit, invalid pack JSON or symlink output fails the build and preserves
the previous exports. Cancellation terminates the Node process and waits for it
to close before workspace cleanup. Successful output receives the same manifest
and content validation as other builder stages. Filters are trusted Node programs;
explicit writes through `ROOT_DIR` or `FILTER_DIR` target those original directories.

Script execution follows Regolith's [Node filter arguments](https://regolith-docs.readthedocs.io/en/stable/filters/node-filters/)
and [working-directory and environment contract](https://regolith-docs.readthedocs.io/en/stable/developing-filters/filter-development-introduction/).
