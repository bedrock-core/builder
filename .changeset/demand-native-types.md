---
'@bedrock-core/builder-generator': minor
'@bedrock-core/builder-bundler': patch
'@bedrock-core/builder-validation': minor
'@bedrock-core/builder': patch
---

Expose native Bedrock document types through the `@bedrock-core/bedrock-types` package root. Keep schema preparation, corrections, declaration compilation and distribution builds in the types package. The generator evaluates content templates using published document types.

Provide detailed animations, controller state machines and render controllers. Share client-resource descriptions and scripts between entities and attachables, retaining their document-specific fields and conditional item bindings.

Expose extensible component registries and reuse their maps in native documents. Standardize declaration cleanup, semantic duplicate detection, bounded-array output and interface spacing.

Use extensionless declaration imports and resolve generated definitions in the package's authoring project. Keep vanilla-only block metadata outside the public authoring API.

Run optional Creator Tools validation on the assembled behavior and resource packs and report rule diagnostics with pack paths.

Check final JSON documents against the installed native Bedrock types for the project's target version. Expose the release as `typesVersion` and each checked document as a `category`. Use `typesRoot` to select an explicit types package.
