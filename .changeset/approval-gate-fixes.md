---
'@openrouter/agent': patch
---

Fix two ways the tool-approval gate could be bypassed.

**`allowFinalResponse` executed pending tool calls with no approval check.** When a `stopWhen` condition halted the loop on a turn that still carried tool calls, the final-response path ran those calls directly — skipping the approval gate the normal loop applies on every round. A tool marked `requireApproval: true` (or gated by a predicate) would execute unguarded, and because the `PermissionRequest` hook's deny bookkeeping lives inside the approval check, hook-based `deny` never fired on this path either. That path now runs the same check as the in-loop call sites, so the run pauses with `status: 'awaiting_approval'` and the gated calls on `pendingToolCalls` instead of executing them.

**Function-based `requireApproval` received unvalidated arguments.** Tool-level and call-level predicates were called with the raw JSON-parsed tool arguments, while `execute` receives the arguments *after* the tool's Zod `inputSchema` runs. Any default, coercion, or transform in the schema made them disagree — e.g. with `inputSchema: z.object({ dangerous: z.boolean().default(true) })`, a model emitting `{}` showed a predicate `dangerous: undefined` (no approval required) and then executed with `dangerous: true`. Predicates now see a parsed copy, so they decide on exactly what `execute` will receive without mutating the original executable call or parsing transformed output a second time. `PreToolUse` now runs before every auto-resolvable call is partitioned, so approval hooks and persisted pending calls see its effective arguments. Pending calls record an additive marker when preparation ran, preventing a resumed `ModelResult` from applying the hook twice while legacy state without the marker retains its prior behavior. Call-level checks remain unconditional and receive raw arguments when parsing fails; tool-level checks fail closed when schema parsing fails because a hook may later repair the input.

**Duplicate approval prompts for the same tool call.** The approval gate could run more than once over the same response — e.g. the pre-loop check plus the post-loop `allowFinalResponse` gate when a stop condition fired on the first iteration — re-emitting the `PermissionRequest` hook and re-running `requireApproval` predicates for calls that were already resolved. Each call occurrence in a response is now gated at most once per run, including responses containing duplicate call IDs and arguments.

```ts
import { z } from 'zod/v4';
import { tool, type PendingToolCall } from '@openrouter/agent';

const deploy = tool({
  name: 'deploy',
  inputSchema: z.object({
    environment: z.enum(['staging', 'production']).default('production'),
  }),
  requireApproval: ({ environment }) => environment === 'production',
  execute: async ({ environment }) => deployEnvironment(environment),
});

// `requireApproval` sees the normalized default: { environment: 'production' }.
// Persist this additive marker when PreToolUse already produced effective args.
const pending: PendingToolCall<typeof deploy> = {
  id: 'call_deploy',
  name: 'deploy',
  arguments: { environment: 'production' },
  preToolUseApplied: true,
};
```
