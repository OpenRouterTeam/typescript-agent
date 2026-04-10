# Composition Tests

Tests in this folder verify that **capabilities compose** — the output of one module is accepted as input by the next. No detailed correctness of individual outputs; just: do they connect?

## What belongs here

- Module A's output shape is accepted by Module B's input
- Data flows through a two-module chain without errors
- Multi-consumer scenarios where the same source feeds multiple consumers
- Cross-module contract verification (e.g., orchestrator utilities consume real executor results)
- Extendable: when new modules are introduced, their connection tests with existing modules go here

## Examples

- `tool()` output is accepted by `isRegularExecuteTool` / `convertToolsToAPIFormat`
- Two `ReusableReadableStream` consumers both receive all items
- `executeNextTurnParamsFunctions` output is accepted by `applyNextTurnParamsToRequest`
- `createUnsentResult` output is accepted by `unsentResultsToAPIFormat`
- `partitionToolCalls` internally uses `toolRequiresApproval`

## What does NOT belong here

- Verifying the detailed correctness of each module's output (→ `behavior/`)
- Verifying that similar modules don't accept each other's input (→ `boundaries/`)
- Full multi-layer pipelines with per-layer assertions (→ `pipelines/`)
