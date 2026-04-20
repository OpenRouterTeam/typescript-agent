# Contracts Tests

Tests in this folder verify that a capability **works as specified AND its boundary with similar capabilities is correct**. Both the "what it does" and the "what it does NOT do" are asserted in the same test.

## What belongs here

- Stop conditions that check their own criterion AND ignore all others
- Delta extractors that yield their event type AND skip peer event types
- Message stream builders that produce their format AND differ structurally from peers
- Executor functions that handle their tool type AND reject the other type
- Async param resolution where static, function, and client-only fields are each handled distinctly
- Extendable: when a capability gains new peers or alternatives, their combined behavior-and-boundary tests go here

## Examples

- `stepCountIs(3)` returns true at 3 steps AND ignores tool names, tokens, cost, finishReason
- `extractTextDeltas` yields text deltas AND skips reasoning + tool deltas in the same stream
- `executeRegularTool` succeeds with regular tools AND throws when given a generator tool
- `resolveAsyncFunctions` passes static values through, resolves functions, AND strips client-only fields
- `fromClaudeMessages` maps text blocks to messages, tool_use to function calls, each distinctly

## What does NOT belong here

- Pure specification without boundary checking (→ `behavior/`)
- Pure boundary checking without verifying output correctness (→ `boundaries/`)
- Cross-module composition (→ `integration/` or `pipelines/`)
