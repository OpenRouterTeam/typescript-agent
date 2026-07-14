---
"@openrouter/agent": minor
---

Persist unresolved manual tool calls (`execute: false` / no execute fn) to `ConversationState.pendingToolCalls` when the loop stops, and set status to the new value `'awaiting_client_tools'`.

Previously, HITL pauses (`onToolCalled → null`) correctly populated `pendingToolCalls` with status `'awaiting_hitl'`, but bare manual tools only `break`'d the loop — `getPendingToolCalls()` returned `[]` and status was left `in_progress`/`complete`. Cold-start consumers could not recover the unresolved calls from serialized state.

- New `ConversationStatus` value: `'awaiting_client_tools'` (additive; does not replace `'awaiting_hitl'`).
- Mixed auto+manual rounds still execute/persist regular tool outputs, then pause with only the unresolved manual calls in `pendingToolCalls`.
- Resume with new input from `'awaiting_client_tools'` clears the stale pendings and continues as a normal turn — callers should harvest `getPendingToolCalls()` from the paused result before continuing. Manual tools are not approved/rejected via call IDs (unlike HITL/`awaiting_approval`).
