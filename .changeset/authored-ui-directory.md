---
"@bedrock-core/builder-ui": minor
"@bedrock-core/builder-i18n": patch
"@bedrock-core/cli": minor
---

Discover authored screens in behavior-pack `UI/` directories, reserve their helpers from content generation and omit UI sources from exported packs. Continue compiling screens under `scripts/` through the same pipeline.

Scaffold UI sources in `packs/BP/UI/` with matching runtime imports and TypeScript includes.

Keep the shared translation instance in `packs/BP/i18n/index.ts` and exclude runtime index modules from locale compilation and detection.
