/** Default plugin entrypoints. Profile stages select these ordered invocations. */
export const builtinPlugins = Object.freeze({
  'manifest': '@bedrock-core/builder-manifest/plugin',
  'generator': '@bedrock-core/builder-generator/plugin',
  'guides': '@bedrock-core/builder-guides/plugin',
  'i18n': '@bedrock-core/builder-i18n/plugin',
  'ui-compiler': '@bedrock-core/builder-ui/plugin',
  'bundler': '@bedrock-core/builder-bundler/plugin',
});
