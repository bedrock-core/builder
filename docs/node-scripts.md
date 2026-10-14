# Node scripts

Define a Node entry under `bedrockCore.plugins` and invoke it in a profile's `steps`. Scripts receive temporary `BP`, `RP` and `data` folders; successful pack edits return to staging before the next operation.

## Run the example

From the builder repository:

```powershell
corepack yarn build examples/node-filter-project/config.json
Get-Content examples/node-filter-project/build/RP/generated.json
```

The [example configuration](../examples/node-filter-project/config.json) invokes a [standalone script](../examples/node-filter-project/filters/main.cjs).

[Node script documentation](https://bedrock-core.drav.dev/docs/builder/guides/node-scripts) covers settings, arguments, environment variables, pack selection and cancellation.
