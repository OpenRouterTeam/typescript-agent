---
'@openrouter/agent': patch
---

Fix two ways the tool-approval gate could be bypassed.

**`allowFinalResponse` executed pending tool calls with no approval check.** When a `stopWhen` condition halted the loop on a turn that still carried tool calls, the final-response path ran those calls directly — skipping the approval gate the normal loop applies on every round. A tool marked `requireApproval: true` (or gated by a predicate) would execute unguarded, and because the `PermissionRequest` hook's deny bookkeeping lives inside the approval check, hook-based `deny` never fired on this path either. That path now runs the same check as the in-loop call sites, so the run pauses with `status: 'awaiting_approval'` and the gated calls on `pendingToolCalls` instead of executing them.

**Function-based `requireApproval` received unvalidated arguments.** The predicate was called with the raw JSON-parsed tool arguments, while `execute` receives the arguments *after* the tool's Zod `inputSchema` runs. Any default, coercion, or transform in the schema made the two disagree — e.g. with `inputSchema: z.object({ dangerous: z.boolean().default(true) })`, a model emitting `{}` showed the predicate `dangerous: undefined` (no approval required) and then executed with `dangerous: true`. The predicate now sees the parsed value, so it decides on exactly what `execute` will receive. If the arguments don't satisfy the schema the gate fails closed and requires approval, rather than judging a value `execute` would never see.
