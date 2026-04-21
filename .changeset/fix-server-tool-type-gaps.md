---
"@openrouter/agent": patch
---

Fix two type gaps that forced consumers to use `as any` when wiring up
`callModel` with server tools and chat-format inputs. Both fixes are
purely additive at the public-type level — `ServerTool` and
`ServerTool<T>` continue to work exactly as before; no consumer code
needs to change.

- **Mixed `Array<ClientTool | ServerTool>` now accepts narrow
  `serverTool()` results without a cast.** Previously `ServerTool<T>`
  defined `config: Extract<ServerToolConfig, { type: T }>`, which made
  it invariant over `T` — so `ServerTool<'openrouter:datetime'>` was
  not assignable to the bare `ServerTool` (= `ServerTool<ServerToolType>`).
  `ServerTool` is now a conditional generic with a `never` default that
  collapses to a non-generic structural base (`ServerToolBase`, also
  newly exported), and narrow variants are represented as an
  intersection with that base — so any `serverTool(...)` result flows
  into `Array<ClientTool | ServerTool>` or `Tool[]` directly.
  `ServerTool<'openrouter:datetime'>` (narrowing `config` at a call
  site) still compiles as before.

- **`callModel`'s `request.input` now accepts `InputsUnion`** (the SDK's
  wider message shape returned by `fromChatMessages()`), alongside the
  existing `Item[]` and plain `string` forms. The docstring on
  `fromChatMessages()` already claims its output "can be passed directly
  to `callModel()`"; the types now match.
