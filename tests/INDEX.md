# Test Registry

This index maps each SDK function/module to its **single test category**. Before adding a test, check this registry — if the function is already covered in a higher category, add your assertion there instead of creating a new file in a lower category.

## Category priority (highest wins)

When a function could belong to multiple categories, place it in the **highest applicable** one:

```
pipelines > dispatch > integration > contracts > composition > boundaries > behavior
```

**Rule: each function gets ONE category.** If `stepCountIs` has meaningful peer boundaries, it goes in `contracts/` — not `behavior/` AND `contracts/`. Functions with no peer comparisons stay in `behavior/`.

---

## Registry

### stop-conditions.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `stepCountIs` | contracts | `contracts/stop-conditions.test.ts` | Checks own criterion AND ignores peer criteria |
| `hasToolCall` | contracts | `contracts/stop-conditions.test.ts` | Checks own criterion AND ignores peer criteria |
| `maxTokensUsed` | contracts | `contracts/stop-conditions.test.ts` | Checks own criterion AND ignores peer criteria |
| `maxCost` | contracts | `contracts/stop-conditions.test.ts` | Checks own criterion AND ignores peer criteria |
| `finishReasonIs` | contracts | `contracts/stop-conditions.test.ts` | Checks own criterion AND ignores peer criteria |
| stop condition evaluation (combined) | behavior | `behavior/stop-conditions-evaluation.test.ts` | Tests `evaluateStopConditions` orchestration logic (no peer comparison) |

### stream-type-guards.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `isOutputTextDeltaEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isReasoningDeltaEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isFunctionCallArgumentsDeltaEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isOutputItemAddedEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isOutputItemDoneEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isResponseCompletedEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isResponseFailedEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isResponseIncompleteEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isFunctionCallArgumentsDoneEvent` | boundaries | `boundaries/stream-event-guards.test.ts` | Mutual exclusion with peer guards |
| `isOutputMessage` | boundaries | `boundaries/output-item-guards.test.ts` | Mutual exclusion with peer guards |
| `isFunctionCallItem` | boundaries | `boundaries/output-item-guards.test.ts` | Mutual exclusion with peer guards |
| `isReasoningOutputItem` | boundaries | `boundaries/output-item-guards.test.ts` | Mutual exclusion with peer guards |
| `isWebSearchCallOutputItem` | boundaries | `boundaries/output-item-guards.test.ts` | Mutual exclusion with peer guards |
| `isFileSearchCallOutputItem` | boundaries | `boundaries/output-item-guards.test.ts` | Mutual exclusion with peer guards |
| `isImageGenerationCallOutputItem` | boundaries | `boundaries/output-item-guards.test.ts` | Mutual exclusion with peer guards |
| `isOutputTextPart` | boundaries | `boundaries/content-annotation-guards.test.ts` | Mutual exclusion with peer guards |
| `isRefusalPart` | boundaries | `boundaries/content-annotation-guards.test.ts` | Mutual exclusion with peer guards |
| `isFileCitationAnnotation` | boundaries | `boundaries/content-annotation-guards.test.ts` | Mutual exclusion with peer guards |
| `isURLCitationAnnotation` | boundaries | `boundaries/content-annotation-guards.test.ts` | Mutual exclusion with peer guards |
| `isFilePathAnnotation` | boundaries | `boundaries/content-annotation-guards.test.ts` | Mutual exclusion with peer guards |
| `hasTypeProperty` | behavior | `behavior/stream-type-guards-negative.test.ts` | Utility function, no peers |
| stream vs output item cross-domain | boundaries | `boundaries/domain-separation.test.ts` | Guards reject events from wrong domain |
| response stream event guards | boundaries | `boundaries/response-stream-event-guards.test.ts` | Mutual exclusion with peer guards |

### tool-types.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `hasExecuteFunction` | boundaries | `boundaries/tool-type-guards.test.ts` | Mutual exclusion across tool types |
| `isRegularExecuteTool` | boundaries | `boundaries/tool-type-guards.test.ts` | Mutual exclusion across tool types |
| `isGeneratorTool` | boundaries | `boundaries/tool-type-guards.test.ts` | Mutual exclusion across tool types |
| `isManualTool` | boundaries | `boundaries/tool-type-guards.test.ts` | Mutual exclusion across tool types |
| `toolRequiresApproval` | behavior | `behavior/tool-approval.test.ts` | No peer comparison, isolated behavior |
| `ToolEventBroadcaster` | behavior | `behavior/tool-event-broadcaster.test.ts` | No peer comparison, isolated behavior |
| tool type events (combined) | behavior | `behavior/tool-types-events.test.ts` | Event shape verification, isolated |

### tool.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `tool()` factory | behavior | `behavior/tool-creation.test.ts` | Isolated factory behavior |
| tool factory shapes (regular vs generator vs manual) | boundaries | `boundaries/tool-factory-shapes.test.ts` | Structural distinction between tool types |

### tool-executor.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `executeRegularTool` | behavior | `behavior/tool-execution.test.ts` | Isolated execution behavior |
| `executeRegularTool` vs `executeGeneratorTool` | contracts | `contracts/execute-tool-boundary.test.ts` | Each handles its type AND rejects the other |
| `executeTool` dispatch | dispatch | `dispatch/execute-tool-dispatch.test.ts` | Routes via type guard to correct executor |

### tool-context.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `resolveContext`, `ToolContextStore` | behavior | `behavior/tool-context.test.ts` | Isolated context resolution |
| `buildToolExecuteContext` | integration | `integration/tool-context-execution.test.ts` | Correct output AND feeds tool execute |

### turn-context.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `buildTurnContext`, `normalizeInputToArray` | behavior | `behavior/turn-context.test.ts` | Isolated shape verification |
| turn context -> async params | integration | `integration/turn-context-async-params.test.ts` | Correct output AND feeds resolveAsyncFunctions |

### async-params.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `resolveAsyncFunctions` | contracts | `contracts/async-params.test.ts` | Static vs function vs client-only handled distinctly |

### conversation-state.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `createInitialState`, `updateState`, `appendToMessages` | behavior | `behavior/conversation-state.test.ts` | Isolated state management |
| `appendToMessages` + format compat | integration | `integration/conversation-state-format.test.ts` | Output feeds format conversion |
| `partitionToolCalls` | dispatch | `dispatch/approval-partition-dispatch.test.ts` | Routes via approval checks |
| `createUnsentResult` vs `createRejectedResult` | boundaries | `boundaries/conversation-state-results.test.ts` | Structural distinction |

### next-turn-params.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `executeNextTurnParamsFunctions` | behavior | `behavior/next-turn-params.test.ts` | Isolated param computation |
| next-turn params -> request | integration | `integration/next-turn-params-request.test.ts` | Output feeds applyNextTurnParamsToRequest |

### reusable-stream.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `ReusableReadableStream` | behavior | `behavior/reusable-stream.test.ts` | Isolated stream behavior |
| multi-consumer correctness | integration | `integration/reusable-stream-consumers.test.ts` | Multiple consumers both get correct data |

### stream-transformers.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `extractTextDeltas`, `extractReasoningDeltas`, `extractToolDeltas` | contracts | `contracts/delta-extractors.test.ts` | Each yields its type AND skips peers |
| `buildMessageStream`, `buildResponsesMessageStream` | contracts | `contracts/message-stream-builders.test.ts` | Each produces distinct format |
| `buildItemsStream` | contracts | `contracts/items-stream.test.ts` | Produces items format distinctly |
| `buildItemsStream` dispatch | dispatch | `dispatch/items-stream-dispatch.test.ts` | Routes events via guards |
| `consumeStreamForCompletion` | contracts | `contracts/consume-stream-completion.test.ts` | Consumes correct terminal event |
| `getResponseObject`, `getTextContent` | contracts | `contracts/response-extractors.test.ts` | Each extracts distinct data |
| `convertToClaudeMessage` | dispatch | `dispatch/claude-conversion-dispatch.test.ts` | Routes items via output guards |
| `consumeStreamForCompletion` + guards | integration | `integration/stream-completion-guards.test.ts` | Correct result AND guard identified event |

### anthropic-compat.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `fromClaudeMessages` | contracts | `contracts/from-claude-messages.test.ts` | Maps each block type distinctly |
| `fromClaudeMessages` dispatch | dispatch | `dispatch/from-claude-dispatch.test.ts` | Routes mixed block types |
| `toClaudeMessage` + `fromClaudeMessages` round-trip | pipelines | `pipelines/format-round-trip.test.ts` | Full conversion pipeline |

### chat-compat.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `toChatMessage` + `fromChatMessages` round-trip | pipelines | `pipelines/format-round-trip.test.ts` | Full conversion pipeline |

### tool-orchestrator.ts

| Function | Category | File | Reason |
|----------|----------|------|--------|
| `mapToolResults`, `summarizeStepUsage`, etc. | behavior | `behavior/tool-orchestrator.test.ts` | Isolated utility functions |

---

## Pipeline tests (cross-cutting)

These tests exercise multiple modules end-to-end and don't map to a single function:

| Pipeline | File |
|----------|------|
| Streaming: events -> guards -> transformers -> consumer | `pipelines/streaming-pipeline.test.ts` |
| Tool execution: create -> dispatch -> validate -> execute -> format | `pipelines/tool-execution-pipeline.test.ts` |
| Context: build -> resolve -> store -> execute | `pipelines/context-pipeline.test.ts` |
| Stop conditions: results -> evaluate -> decision | `pipelines/stop-condition-pipeline.test.ts` |
| Dual-format output: same response -> chat + Claude + items | `pipelines/dual-format-output.test.ts` |
| Claude conversion deep: multi-item -> per-item routing -> blocks | `pipelines/claude-conversion-deep.test.ts` |
| Next-turn params: tool results -> compute -> apply to request | `pipelines/next-turn-params-pipeline.test.ts` |
| Async resolution: resolve -> apply -> evaluate stop | `pipelines/async-resolution-pipeline.test.ts` |
| Orchestrator chain: execute -> map -> summarize -> check errors | `pipelines/orchestrator-utility-chain.test.ts` |
| Approval -> execution -> state: partition -> execute -> format | `pipelines/approval-execution-state.test.ts` |
| Format round-trip: Claude and Chat bidirectional conversion | `pipelines/format-round-trip.test.ts` |

## Composition tests (two-module connection)

| Connection | File |
|------------|------|
| tool() -> type guards / convertToolsToAPIFormat | `composition/tool-lifecycle.test.ts` |
| ReusableReadableStream -> multiple consumers | `composition/stream-data-pipeline.test.ts` |
| executeNextTurnParamsFunctions -> applyNextTurnParamsToRequest | `composition/next-turn-params-flow.test.ts` |
| toChatMessage -> fromChatMessages (format round-trip) | `composition/format-compatibility.test.ts` |
| buildToolExecuteContext -> tool execute | `composition/context-flow.test.ts` |
| appendToMessages -> state update | `composition/input-normalization.test.ts` |
| createInitialState -> updateState | `composition/state-machine.test.ts` |
| orchestrator utilities -> executor results | `composition/orchestrator-executor.test.ts` |
