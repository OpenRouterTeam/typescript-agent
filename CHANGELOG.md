# @openrouter/agent

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
