# Dispatch Tests

Tests in this folder verify that **boundaries between capabilities hold at their composition points**. The correct path is chosen AND the modules connect. This is where routing logic meets module integration.

## What belongs here

- `executeTool` dispatching to the correct executor based on type guards
- `convertToClaudeMessage` routing items via output item guards to distinct Claude blocks
- `buildItemsStream` routing events via stream type guards to correct handlers
- `fromClaudeMessages` routing mixed block types to distinct output types
- Approval partitioning choosing the correct path based on tool-level vs call-level checks
- Extendable: when new routing or dispatching logic is added, its boundary-at-junction tests go here

## Examples

- `executeTool` dispatches regular tool to `executeRegularTool` because `isRegularExecuteTool` returns true
- Same response with message + function_call: `isOutputMessage` -> text block, `isFunctionCallItem` -> tool_use block
- `partitionToolCalls` with call-level check overrides tool-level `requireApproval`
- `buildItemsStream` routes `output_item.added` to handler because `isOutputItemAddedEvent` matches

## What does NOT belong here

- Pure boundary testing without composition (→ `boundaries/`)
- Pure composition without boundary verification (→ `composition/`)
- Full end-to-end pipelines (→ `pipelines/`)
