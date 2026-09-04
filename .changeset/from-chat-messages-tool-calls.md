---
'@openrouter/agent': patch
---

Fix `fromChatMessages` to convert assistant `toolCalls` to `function_call` items, and widen `callModel`'s `input` type to accept `models.InputsUnion`.
