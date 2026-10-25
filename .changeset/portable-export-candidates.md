---
"@bedrock-core/builder": patch
---

Ignore absent export exclusions beneath regular files, preserving imported JSON assets during UI builds. Recognize local migration wrappers by canonical paths within the trusted checkout. Canonicalize temporary workspaces so artifact ownership checks accept Windows short paths and filesystem aliases.
