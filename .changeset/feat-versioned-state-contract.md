---
"@openrouter/agent": minor
---

Add a versioned `ConversationState` serialization contract.

- Optional `version` field on `ConversationState` (absence means v1); `createInitialState` now stamps `version: 1`.
- New helpers: `serializeConversationState` / `deserializeConversationState` (package root + `@openrouter/agent/conversation-state`).
- Typed errors: `UnsupportedStateVersionError` (`{found, supported}`) and `InvalidStateError` for malformed payloads.
- Compat policy: treat JSON as opaque; additive changes within a major; migrations run in `deserializeConversationState` on version bump. StateAccessor load/save is unchanged — helpers are opt-in wrappers over what consumers already do with `JSON.stringify`/`parse`.
