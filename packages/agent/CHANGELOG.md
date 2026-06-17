# @openrouter/agent

## 0.7.2

### Patch Changes

- [#53](https://github.com/OpenRouterTeam/typescript-agent/pull/53) [`a5341f2`](https://github.com/OpenRouterTeam/typescript-agent/commit/a5341f21555b5d2d982484c199d7d9c3093eabe6) Thanks [@Cybourgeoisie](https://github.com/Cybourgeoisie)! - Bump @openrouter/sdk to 0.13.7

## 0.7.0

### Minor Changes

- Add `allowFinalResponse` option to `callModel`, sibling of `stopWhen`. When the agent loop is halted by `stopWhen` while the last model response still contains tool calls, the pending tool calls are executed (so they have matching outputs) and one more model request is made with no tools so the loop ends with a natural-language summary instead of an unfinished tool call. Passing a string instead of `true` additionally appends that string as a final `user` message (e.g. `allowFinalResponse: 'Please summarize what you found.'`). The full accumulated input array and the original `instructions` are sent.

## 0.6.0

### Minor Changes

- [#42](https://github.com/OpenRouterTeam/typescript-agent/pull/42) [`8e71f06`](https://github.com/OpenRouterTeam/typescript-agent/commit/8e71f06024f41e60ccdc68577016637a31912779) Thanks [@mattapperson](https://github.com/mattapperson)! - Remove implicit 5-step cap in `callModel`. When `stopWhen` is omitted, the tool-execution loop now runs until the model produces a turn with no tool calls instead of stopping at 5 steps. Pass an explicit `stopWhen` (e.g. `stepCountIs(n)`, `maxCost(...)`, `maxTokensUsed(...)`) to bound iterations.

## 0.5.0

### Minor Changes

- Add human-in-the-loop (HITL) tool type, a new `ClientTool` variant that sits
  between regular `execute` tools and `manual` tools. HITL tools define two
  async hooks:

  - `onToolCalled(input, context)` runs when the model invokes the tool.
    Return a value to feed the model directly (like a regular `execute` tool),
    or return `null` to pause the conversation so the caller can supply the
    output later — the same flow used by manual tools.
  - `onResponseReceived(rawResult, context)` runs on the next turn when an
    incoming `function_call_output` matches a prior call of this tool. It lets
    the caller transform or validate the raw response before it reaches the
    model. Throwing surfaces as a tool error to the model.

  HITL tools require an `outputSchema`, which is used to validate both the
  `onToolCalled` return value (when non-null) and caller-supplied responses
  (after any `onResponseReceived` transform, or as-is when no hook is defined).

  New `ConversationStatus` value `'awaiting_hitl'` is emitted when one or more
  HITL tools return `null` from `onToolCalled`, signaling that the caller
  should resume with outputs for the paused calls.

  New public exports:

  - Types: `HITLTool`, `HITLToolFunction`
  - Guards: `isHITLTool`, `isAutoResolvableTool` (true for execute / generator
    / HITL tools — i.e. anything that can resolve within a turn)

  `isManualTool` now returns `false` for HITL tools, so existing manual-tool
  branches continue to behave correctly.

### Patch Changes

- [#34](https://github.com/OpenRouterTeam/typescript-agent/pull/34) [`61aca10`](https://github.com/OpenRouterTeam/typescript-agent/commit/61aca10fd9434fe69fbe1e069e4b1858613a7da7) Thanks [@w0nche0l](https://github.com/w0nche0l)! - Detect streamed Responses API results by readable stream behavior instead of constructor names or unsupported adapters.

## 0.4.0

### Minor Changes

- [#30](https://github.com/OpenRouterTeam/typescript-agent/pull/30) [`e4e3ed5`](https://github.com/OpenRouterTeam/typescript-agent/commit/e4e3ed5e0a4f132e8cae1c33d7831f65aa46c211) Thanks [@mattapperson](https://github.com/mattapperson)! - Add `serverTool()` factory for OpenRouter's server-executed tools (web search, `openrouter:datetime`, image generation, MCP, file search, code interpreter, and future SDK additions). Server tools can be mixed with client `tool()`s in the `callModel({ tools })` array; OpenRouter runs them and their output items flow through the unified `ModelResult.allToolExecutionRounds[].toolResults` list.

  - `getItemsStream()` yields server-tool output items (e.g. `web_search_call`, `openrouter:datetime`) alongside client `function_call` / `function_call_output` items. The yielded union is narrowed from the `TTools` passed to `callModel`, so consumers only see item types that are reachable for their tool set.
  - `StepResult.serverToolResults` exposes provider-side tool invocations to `stopWhen` conditions (the existing `toolResults` field remains client-tool-only).
  - New public exports: `serverTool`, `isServerTool`, `isClientTool`, and the types `ServerTool`, `ServerToolConfig`, `ServerToolType`, `ServerToolResultItem`, `ClientTool`, `ToolResultItem`.

### Patch Changes

- [#25](https://github.com/OpenRouterTeam/typescript-agent/pull/25) [`ec94de8`](https://github.com/OpenRouterTeam/typescript-agent/commit/ec94de8c16fa114ba1e6369db25b4a2cd4ebc359) Thanks [@jakobcastro](https://github.com/jakobcastro)! - Bump @openrouter/sdk from 0.11.2 to 0.12.12, which adds `xhigh` and `max` to the `Verbosity` enum for `TextExtendedConfig`

## 0.3.3

### Patch Changes

- [#27](https://github.com/OpenRouterTeam/typescript-agent/pull/27) [`ef15761`](https://github.com/OpenRouterTeam/typescript-agent/commit/ef157612ca213d23ef1bfbfec012db09144315bf) Thanks [@mattapperson](https://github.com/mattapperson)! - Fix `hooks` constructor option silently no-oping when a plain hook object (e.g. `{ beforeRequest: ... }`) was passed: the underlying SDK only honors `hooks` when it is an `SDKHooks` instance, and the previous wrapper forwarded the plain object unchanged.

  `new OpenRouter({ hooks })` now accepts any of:

  - an `SDKHooks` instance (used as-is),
  - a single hook object (`BeforeRequestHook`, `AfterSuccessHook`, etc.), or
  - an array of hook objects.

  Shorthand inputs are normalized into an `SDKHooks` instance before handoff. Hook types (`BeforeRequestHook`, `BeforeRequestContext`, `AfterSuccessHook`, `SDKHooks`, etc.) are now re-exported from the package entry point.

## 0.3.1

### Patch Changes

- [#22](https://github.com/OpenRouterTeam/typescript-agent/pull/22) [`ab5a75c`](https://github.com/OpenRouterTeam/typescript-agent/commit/ab5a75c43d75f33c0a12e4558c11fd98457d2a6c) Thanks [@mattapperson](https://github.com/mattapperson)! - Fix type exports and add pre-push hooks

  - Add `NewDeveloperMessageItem` type export for manually added developer messages
  - Fix `FieldOrAsyncFunction` type import path in async-params module
  - Add `.npmignore` to exclude development files from published package
  - Add husky pre-push hooks for lint and typecheck validation

## 0.3.0

### Minor Changes

- [#19](https://github.com/OpenRouterTeam/typescript-agent/pull/19) [`2b23076`](https://github.com/OpenRouterTeam/typescript-agent/commit/2b2307683b55debcd406eb68a3b95030a14bfaaf) Thanks [@mattapperson](https://github.com/mattapperson)! - Re-export SDK model types and add clean item type aliases so consumers don't need to depend on `@openrouter/sdk` directly.

### Patch Changes

- [#20](https://github.com/OpenRouterTeam/typescript-agent/pull/20) [`f0d2d72`](https://github.com/OpenRouterTeam/typescript-agent/commit/f0d2d72d042c2acb73d911c5aeb40ccb72ffaf9f) Thanks [@mattapperson](https://github.com/mattapperson)! - Re-export `EasyInputMessageContentInputImage`, `OutputInputImage`, and `OpenAIResponsesToolChoiceUnion` from `@openrouter/sdk/models` so consumers can use these types without a direct SDK dependency.

## 0.2.0

### Minor Changes

- Re-export SDK model types (`ResponsesRequest`, `OutputMessage`, `FunctionCallItem`, etc.) from `@openrouter/sdk/models` so consumers don't need a direct dependency on `@openrouter/sdk`.
- Add clean item type aliases (`Item`, `UserMessageItem`, `AssistantMessageItem`, `FunctionResultItem`, etc.) via new `@openrouter/agent` exports.
- Add `OpenRouter` wrapper class that extends `OpenRouterCore` for a simplified API (`@openrouter/agent/openrouter`).

### Patch Changes

- Replace ESLint with Biome for linting and formatting.
- Add CI auto-release workflow on push to main.
- Correct item type aliases to match SDK runtime types.

## 0.1.2

### Patch Changes

- [#13](https://github.com/OpenRouterTeam/typescript-agent/pull/13) [`93a88a8`](https://github.com/OpenRouterTeam/typescript-agent/commit/93a88a875dcce623202b6747843d3d513f032d12) Thanks [@mattapperson](https://github.com/mattapperson)! - fix: export OpenRouter class from package entry point

## 0.1.1

### Patch Changes

- [#4](https://github.com/OpenRouterTeam/typescript-agent/pull/4) [`546b07d`](https://github.com/OpenRouterTeam/typescript-agent/commit/546b07df300d829bdb9f867cd9c24f60d3337ce2) Thanks [@robert-j-y](https://github.com/robert-j-y)! - Fix type errors in test mocks, add null→undefined sanitization in applyNextTurnParamsToRequest, and release-gate publishing via workflow_dispatch
