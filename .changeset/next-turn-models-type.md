---
'@openrouter/agent': patch
---

Type `NextTurnParamsContext.models` as `NonNullable<models.ResponsesRequest['models']>` instead of a hand-written `string[]`. It now follows the SDK's generated request type: `string[]` today, and reason-gated fallback entries once the SDK spec regenerates. With the current SDK there is no type change.
