---
'@openrouter/agent': minor
---

Add a typed lifecycle hook system to `callModel`, inspired by the Claude Agent SDK hooks pattern.

Two usage modes: an inline config object (built-in hooks only) or a `HooksManager` instance (custom hooks, dynamic registration via `on()`/`off()`/`removeAll()`, programmatic `emit()`).

Eight built-in hooks: `PreToolUse` (block or mutate tool input before every client-tool execution), `PostToolUse` / `PostToolUseFailure` (observe results and errors with timing), `UserPromptSubmit` (mutate or reject the prompt before the initial request), `PermissionRequest` (programmatically allow/deny/ask for tools requiring approval), `Stop` (force-resume a halted loop or inject a follow-up prompt, capped against runaway handlers), and `SessionStart` / `SessionEnd` (paired once per run on every exit path, including approval pauses, interruptions, errors, and no-tools streaming paths).

Features: tool matchers (string / RegExp / predicate), payload filter predicates, sequential mutation piping, short-circuit on block/reject, async fire-and-forget handlers with `drain()` / `abortInflight()` / per-handler timeouts and cooperative cancellation via `ctx.signal`, configurable error handling (`throwOnHandlerError`), and custom hook definitions via Zod schema pairs with full TypeScript inference (transforms/defaults are honored — handlers receive parsed output values).

The API is additive: existing `onTurnStart`, `onTurnEnd`, and `requireApproval` are unchanged. Public exports: `HooksManager`, `HookName`, `isAsyncOutput`, and the payload/result/config types; also available via the `@openrouter/agent/hooks-manager` subpath.
