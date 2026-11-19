---
"@bedrock-core/builder-bundler": patch
---

Keep debug source maps linked to authored and external TypeScript files when packs are exported, including cached builds. Include the generated JavaScript filename for debugger lookup.

Retain generated debug sources in the project cache so their frames remain inspectable after temporary build cleanup.
