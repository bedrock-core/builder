---
"@bedrock-core/builder-ui": minor
"@bedrock-core/builder-i18n": patch
"@bedrock-core/cli": minor
---

Discover authored screens in behavior-pack `ui/` directories, reserve their helpers from content generation and omit UI sources from exported packs. Continue compiling screens under `scripts/` through the same pipeline.

Scaffold UI sources directly in `packs/BP/ui/` with matching runtime imports and TypeScript includes. Match the starter's exact UI dependency to its shared render-pack requirement.

Keep the shared translation instance in `packs/BP/i18n/index.ts` and exclude runtime index modules from locale compilation and detection.
