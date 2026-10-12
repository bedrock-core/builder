---
"@bedrock-core/builder": minor
"@bedrock-core/builder-plugin": minor
"@bedrock-core/builder-manifest": minor
"@bedrock-core/builder-bundler": minor
"@bedrock-core/builder-generator": minor
"@bedrock-core/builder-i18n": minor
"@bedrock-core/builder-guides": minor
"@bedrock-core/builder-ui": minor
---

Resolve profile-selected pack graphs and module selectors, route feature output through
declared local resource dependencies, and generate shared project metadata for manifests
and runtime registration. Native manifests inherit project defaults and preserve
authored pack and module identities. Client translation output requires a
linked local resource pack; runtime-only translations select `client: false`.

Discover locales inside each owner pack, reserve them from template generation and
omit build sources from publication after consumers finish. Generate distinct per-pack
runtime imports and declarations, and compose independent language sections in shared
resource destinations with conflict diagnostics.
