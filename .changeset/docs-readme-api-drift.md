---
"@openrouter/agent": patch
---

Docs: fix three README/API drifts found while building production agents — tool context is `ctx.local` (not `ctx.context`); the `state` option takes a `StateAccessor` (`{load, save}`) and state is read via `result.getState()` (not `(await getResponse()).state`); `getToolStream()` emits argument deltas + generator preliminary results, while execution results are on `getFullResponsesStream()`. Adds a streams cheat-sheet table.
