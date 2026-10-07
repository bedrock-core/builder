# @bedrock-core guides example

```sh
yarn node bin/build.ts examples/guides-project/config.json
```

Run from the builder repository. The example compiles two locales into a guide manifest,
language files and an i18n runtime bundle, then bundles the manifest-declared script entry.
`compileScreens: false` demonstrates content generation without the guide/UI runtime packages.
Install `@bedrock-core/guides` and its UI peers in an addon project and omit that setting to
compile guide screens automatically. See the [guides package](../../packages/guides/README.md).
