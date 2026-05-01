# @openrouter/agent

## 0.4.1

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
