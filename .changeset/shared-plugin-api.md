---
"@bedrock-core/builder": minor
"@bedrock-core/builder-plugin": minor
"@bedrock-core/builder-manifest": minor
"@bedrock-core/builder-bundler": minor
"@bedrock-core/builder-generator": minor
"@bedrock-core/builder-guides": minor
"@bedrock-core/builder-i18n": minor
"@bedrock-core/builder-ui": minor
"@bedrock-core/builder-validation": minor
---

Expose package-owned `./plugin` entrypoints through the shared build context and
plugin contracts. Declare public export paths explicitly and keep implementation
helpers private. Bundler extensions contribute compiler plugins, virtual modules,
resolution settings and tracked inputs with conservative cache reuse. Standalone
packages load using their own declared dependencies.
