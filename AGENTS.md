# @bedrock-core/builder

This is an independent Git repository. Keep builder work here; coordinate changes to
other workspace repositories separately. Documentation-site changes belong in a
requested docs worktree.

Document public exports and caller-visible contracts with JSDoc. Explain paths,
defaults, ownership, cancellation and failure behavior where callers need them.
Keep examples on public package imports and describe the current implementation.
Avoid repeating obvious field names or documenting private helpers without a need.

Use ESLint and @stylistic for formatting: two-space indentation, single quotes, semicolons,
explicit blocks and readable statement spacing. Run `yarn lint` and `yarn typecheck`.
Run `yarn test` after behavior changes. Verify package declarations when public types
or exported APIs change.
