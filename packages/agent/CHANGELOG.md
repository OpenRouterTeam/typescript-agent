# @openrouter/agent

## 0.8.0

### Minor Changes

- [#66](https://github.com/OpenRouterTeam/typescript-agent/pull/66) [`c83cceb`](https://github.com/OpenRouterTeam/typescript-agent/commit/c83cceb17ec1d66b9a1fd2d46ac8ac9b6e60fa4c) Thanks [@LukasParke](https://github.com/LukasParke)! - Add a versioned `ConversationState` serialization contract.

  - Optional `version` field on `ConversationState` (absence means v1); `createInitialState` now stamps `version: 1`.
  - New helpers: `serializeConversationState` / `deserializeConversationState` (package root + `@openrouter/agent/conversation-state`).
  - Typed errors: `UnsupportedStateVersionError` (`{found, supported}`) and `InvalidStateError` for malformed payloads.
  - Compat policy: treat JSON as opaque; additive changes within a major; migrations run in `deserializeConversationState` on version bump. StateAccessor load/save is unchanged — helpers are opt-in wrappers over what consumers already do with `JSON.stringify`/`parse`.

- [#68](https://github.com/OpenRouterTeam/typescript-agent/pull/68) [`6807c51`](https://github.com/OpenRouterTeam/typescript-agent/commit/6807c51d56a35e07a2c549d92ab6d8a0c106ac0a) Thanks [@LukasParke](https://github.com/LukasParke)! - The forced final turn after `stopWhen` halts mid-tool-call is now **on by default** and uses `toolChoice: 'none'` instead of stripping `tools` (stripping busted the prompt-cache prefix). It appends a built-in final-answer directive (exported as `DEFAULT_FINAL_RESPONSE_DIRECTIVE`) as the final user message. Previously the final turn required opting in via `allowFinalResponse`, stripped the tools block, and bare `true` appended no directive — models that emit tool-call syntax as text (e.g. GLM) would attempt another tool call and leak unparsed `<tool_call>…` text into the final content (DEV-658).

  ```ts
  callModel(client, {
    model: "z-ai/glm-5.2",
    input: "Research this step by step.",
    tools: [searchTool],
    stopWhen: stepCountIs(3),
    // was: no final turn unless allowFinalResponse was set; bare `true`
    //      stripped tools (cache-busting) and appended no directive, so
    //      GLM-style models could leak raw `<tool_call>…` as the answer
    // now: default-on final turn with toolChoice:'none' (tools kept, cache
    //      preserved) + DEFAULT_FINAL_RESPONSE_DIRECTIVE user message

    // custom wording still overrides the default:
    // allowFinalResponse: 'Summarize what you found.',
    // append no message (turn still happens):
    // allowFinalResponse: '',
    // restore the old opt-out (no final turn, run ends on the tool-call turn):
    // allowFinalResponse: false,
  });
  ```

  Note: runs that previously ended on a halted tool-call turn now make one additional model request by default. Pass `allowFinalResponse: false` to keep the old behavior.

- [#64](https://github.com/OpenRouterTeam/typescript-agent/pull/64) [`e4d06e3`](https://github.com/OpenRouterTeam/typescript-agent/commit/e4d06e38215d6eafbd5c198e3485f476e65d26f0) Thanks [@LukasParke](https://github.com/LukasParke)! - Persist unresolved manual tool calls (`execute: false` / no execute fn) to `ConversationState.pendingToolCalls` when the loop stops, and set status to the new value `'awaiting_client_tools'`.

  Previously, HITL pauses (`onToolCalled → null`) correctly populated `pendingToolCalls` with status `'awaiting_hitl'`, but bare manual tools only `break`'d the loop — `getPendingToolCalls()` returned `[]` and status was left `in_progress`/`complete`. Cold-start consumers could not recover the unresolved calls from serialized state.

  - New `ConversationStatus` value: `'awaiting_client_tools'` (additive; does not replace `'awaiting_hitl'`).
  - Mixed auto+manual rounds still execute/persist regular tool outputs, then pause with only the unresolved manual calls in `pendingToolCalls`.
  - A successful resume with new input from `'awaiting_client_tools'` clears the stale pendings and continues as a normal turn. Failed resume requests leave the paused state intact. Manual tools are not approved/rejected via call IDs (unlike HITL/`awaiting_approval`).

- [#7](https://github.com/OpenRouterTeam/typescript-agent/pull/7) [`80ff8a7`](https://github.com/OpenRouterTeam/typescript-agent/commit/80ff8a730292aa00a3acfcce6ab1e9f5a6a7f0de) Thanks [@mattapperson](https://github.com/mattapperson)! - Add a typed lifecycle hook system to `callModel`, inspired by the Claude Agent SDK hooks pattern.

  Two usage modes: an inline config object (built-in hooks only) or a `HooksManager` instance (custom hooks, dynamic registration via `on()`/`off()`/`removeAll()`, programmatic `emit()`).

  Eight built-in hooks: `PreToolUse` (block or mutate tool input before every client-tool execution), `PostToolUse` / `PostToolUseFailure` (observe results and errors with timing), `UserPromptSubmit` (mutate or reject the prompt before the initial request), `PermissionRequest` (programmatically allow/deny/ask for tools requiring approval), `Stop` (force-resume a halted loop or inject a follow-up prompt, capped against runaway handlers), and `SessionStart` / `SessionEnd` (paired once per run on every exit path, including approval pauses, interruptions, errors, and no-tools streaming paths).

  Features: tool matchers (string / RegExp / predicate), payload filter predicates, sequential mutation piping, short-circuit on block/reject, async fire-and-forget handlers with `drain()` / `abortInflight()` / per-handler timeouts and cooperative cancellation via `ctx.signal`, configurable error handling (`throwOnHandlerError`), and custom hook definitions via Zod schema pairs with full TypeScript inference (transforms/defaults are honored — handlers receive parsed output values).

  The API is additive: existing `onTurnStart`, `onTurnEnd`, and `requireApproval` are unchanged. Public exports: `HooksManager`, `HookName`, `isAsyncOutput`, and the payload/result/config types; also available via the `@openrouter/agent/hooks-manager` subpath.

- [#56](https://github.com/OpenRouterTeam/typescript-agent/pull/56) [`209499a`](https://github.com/OpenRouterTeam/typescript-agent/commit/209499abacd6783ee5c98155bb2a676e3932c3f4) Thanks [@mattapperson](https://github.com/mattapperson)! - Add a `source` discriminant to tool results so untyped MCP tools no longer collapse the type safety of typed tools.

  Previously, mixing an MCP tool (whose output schema is `unknown`) with fully-typed tools in one `callModel({ tools })` array collapsed the entire result union to `unknown` — one untyped tool poisoned every other tool's result type.

  - `ToolExecutionResult` (and `ToolExecutionResultUnion`) now carry `source: 'client' | 'mcp'`. Narrowing on `source === 'client'` recovers the precise, schema-derived results for your own tools; MCP results stay isolated as `unknown` under `source === 'mcp'`.
  - `ToolResultEvent` (streaming: `getFullResponsesStream`, `getToolStream`) gains the same `source` field. **Breaking:** the `tool.result` event payload now includes `source`; consumers that constructed or exhaustively matched these events may need to account for it.
  - `@openrouter/agent` exports a `markMcp()` helper, an `isMcpTool()` guard, and the `McpBranded` type. `@openrouter/mcp` brands every wrapped tool (including synthetic `list_resources`/`read_resource`) so the discrimination is automatic — callers just spread `mcp.tools` as before.
  - MCP tools continue to execute locally and serialize to the wire as `type: 'function'`; the brand is purely informational and does not change runtime behavior.

- [#67](https://github.com/OpenRouterTeam/typescript-agent/pull/67) [`cb83f45`](https://github.com/OpenRouterTeam/typescript-agent/commit/cb83f45209ff66f8c58077f4e0a85d35f884afdb) Thanks [@LukasParke](https://github.com/LukasParke)! - Add a `PostModelCall` lifecycle hook and aggregate usage totals on `SessionEnd` — the telemetry primitives for tracing and benchmark consumers.

  `PostModelCall` fires once per completed model response, on **every** request the agent loop makes: the initial request, each tool-round follow-up, the empty-final retry, the `allowFinalResponse` final turn, and approval-resume requests. The payload carries `responseId` (the OpenRouter generation id, deep-linkable), `model`, `durationMs` (dispatch to fully materialized response, including stream consumption), `turnType` (`'initial' | 'resume' | 'tool_round' | 'final' | 'retry'`), `turnNumber`, and a normalized `usage` block (`inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, `cost?`) when the server reported usage accounting. Purely observational: handlers cannot mutate or block.

  `SessionEnd` now carries an optional `totalUsage` aggregate (`modelCalls` plus the summed usage fields, with `cost` present when any call reported one) whenever at least one model call completed during the run.

  New exported types: `PostModelCallPayload`, `ModelCallUsage`, `SessionUsageTotals`.

### Patch Changes

- [#62](https://github.com/OpenRouterTeam/typescript-agent/pull/62) [`1362232`](https://github.com/OpenRouterTeam/typescript-agent/commit/1362232975f0254343f9842f30ec1b35d391f4fe) Thanks [@LukasParke](https://github.com/LukasParke)! - Docs: fix three README/API drifts found while building production agents — tool context is `ctx.local` (not `ctx.context`); the `state` option takes a `StateAccessor` (`{load, save}`) and state is read via `result.getState()` (not `(await getResponse()).state`); `getToolStream()` emits argument deltas + generator preliminary results, while execution results are on `getFullResponsesStream()`. Adds a streams cheat-sheet table.

- [#65](https://github.com/OpenRouterTeam/typescript-agent/pull/65) [`09a041e`](https://github.com/OpenRouterTeam/typescript-agent/commit/09a041ea717b384c6c85d7c81ef391b170b0dd8f) Thanks [@LukasParke](https://github.com/LukasParke)! - Infer tool context types from `contextSchema` end-to-end: `tool()` now preserves the concrete Zod schema through its overloads, so `execute`'s `ctx.local` is typed from the schema and `callModel`'s `context` map slots accept/reject the real per-tool shape — no more `ctx.local as X` or `context: map as any`. Tools without a `contextSchema` still resolve their map slot to `Record<string, never>`. Types-only; runtime behavior unchanged.

- [#61](https://github.com/OpenRouterTeam/typescript-agent/pull/61) [`c020bc7`](https://github.com/OpenRouterTeam/typescript-agent/commit/c020bc7c86d2f743ecf9158ca3c9ff7b315e43b3) Thanks [@LukasParke](https://github.com/LukasParke)! - Fix: bare string `input` is now normalized into a message item when resuming a conversation with loaded history. Previously the raw string was appended to the request input array un-normalized, causing an OpenResponses 400 validation error on the advertised string-input style.

- [#63](https://github.com/OpenRouterTeam/typescript-agent/pull/63) [`d96cd9f`](https://github.com/OpenRouterTeam/typescript-agent/commit/d96cd9fc589c27978bcdc2fd1921f754be88e3f0) Thanks [@LukasParke](https://github.com/LukasParke)! - Tolerate empty final `output` after completed tool rounds: retry the follow-up request once, then resolve successfully with empty text instead of throwing `Invalid final response: empty or invalid output`. Mini-class models intermittently treat a successful tool call as the terminal answer. Opt into the old throw with `strictFinalResponse: true`. Runs with no completed tool work still throw on empty output.

- [#59](https://github.com/OpenRouterTeam/typescript-agent/pull/59) [`8edae63`](https://github.com/OpenRouterTeam/typescript-agent/commit/8edae63f4f6fe89e146f3abbf6d24dab7a164681) Thanks [@ayush-or](https://github.com/ayush-or)! - Stop the tool-execution loop when a round contains unresolved manual (client-executed) tool calls, instead of sending a follow-up request whose input carries a `function_call` with no matching `function_call_output` — a history providers reject with a 400 "No tool output found for function call ...". The response is surfaced so the caller can execute the manual calls and continue, mirroring the existing all-manual behavior.

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
