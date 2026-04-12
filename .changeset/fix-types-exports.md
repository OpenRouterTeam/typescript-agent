---
"@openrouter/agent": patch
---

Fix type exports and add pre-push hooks

- Add `NewDeveloperMessageItem` type export for manually added developer messages
- Fix `FieldOrAsyncFunction` type import path in async-params module
- Add `.npmignore` to exclude development files from published package
- Add husky pre-push hooks for lint and typecheck validation
