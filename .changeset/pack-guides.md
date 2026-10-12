---
"@bedrock-core/builder": minor
"@bedrock-core/builder-guides": minor
"@bedrock-core/builder-generator": minor
"@bedrock-core/builder-ui": minor
"@bedrock-core/cli": minor
---

Compile guides from each owner pack, with separate generated manifests, typed imports
and language contributions routed to declared local resource dependencies. Reserve
guide inputs from template generation and omit them from published packs. Preserve
independent language sections and reject conflicting keys in shared destinations.
Keep CLI guide samples inside the behavior pack and resolve builder guide paths
relative to their owner. Standalone compilation resolves paths from the supplied root.
