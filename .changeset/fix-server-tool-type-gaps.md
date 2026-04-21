---
"@openrouter/agent": patch
---

Fix two type gaps that forced consumers to use `as any` when wiring up
`callModel` with server tools and chat-format inputs:

- **`ServerTool` is now a structural-base alias**, not a generic. The
  factory returns a narrow `ServerToolNarrow<T>` that extends
  `ServerToolBase` via interface extension, so a specific
  `ServerToolNarrow<'openrouter:datetime'>` flows into the public
  `ServerTool` alias without a cast. Mixed arrays like
  `Array<ClientTool | ServerTool>` or `Tool[]` now accept any mix of
  `tool()` and `serverTool()` results directly. New public types:
  `ServerToolBase` (structural base) and `ServerToolNarrow<T>` (narrow
  form when the exact `config` shape matters). The old `ServerTool<T>`
  generic is replaced by `ServerToolNarrow<T>`; code that only used
  `ServerTool` without a type argument is unaffected.

- **`callModel`'s `request.input` now accepts `InputsUnion`** (the SDK's
  wider message shape returned by `fromChatMessages()`), alongside the
  existing `Item[]` and plain `string` forms. The docstring on
  `fromChatMessages()` already claims its output "can be passed directly
  to `callModel()`"; the types now match.
