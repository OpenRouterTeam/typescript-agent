---
'@openrouter/agent': patch
---

Fix `fromChatMessages` dropping assistant tool calls, and make the message-conversion helpers' return type usable as `callModel` input.

Runtime (#11): the assistant branch of `fromChatMessages` only read `msg.content` and never `msg.toolCalls`, so a tool-calling assistant message — which conventionally carries `content: null` — converted to `{ role: 'assistant', content: '' }` and the tool call vanished. Any agentic loop replayed through this helper lost its tool calls and left the following `function_call_output` items orphaned. The conversion is now an accumulator loop that emits one `function_call` item per entry in `toolCalls` (mirroring `fromClaudeMessages`), so a single chat message can fan out to multiple items. `ChatToolCall.function.arguments` is already a JSON string in the chat format and is forwarded as-is — not re-stringified. The message item itself is skipped only when content is empty *and* tool calls take its place; a content-less assistant message with no tool calls still round-trips as an empty message, as before.

Types (#41): `fromChatMessages` and `fromClaudeMessages` declared `models.InputsUnion`, which is not assignable to `callModel`'s `input` (`FieldOrAsyncFunction<Item[]> | string`) — the documented usage `callModel({ input: fromChatMessages(msgs) })` did not typecheck. Both now return `Item[]`. The `Item` union gains `NewAssistantMessageItem` and `NewSystemMessageItem` (id-less input messages for the `assistant` and `system` roles, following the existing `New*` pattern), since it previously had no id-less member for either role — `AssistantMessageItem` is the model's `OutputMessage` and requires an `id` plus structured content. Both new types are exported.
