# Boundaries Tests

Tests in this folder verify that **similar capabilities are correctly bounded from each other**. "This one handles X; that one handles Y; they don't bleed." Each guard, classifier, or extractor must accept its own domain and reject its peers.

## What belongs here

- Mutual exclusion between type guards (stream event guards, output item guards, content part guards)
- Cross-domain rejection (stream guards reject output items and vice versa)
- Tool type classifier mutual exclusion (regular vs generator vs manual)
- Null/undefined/malformed input safety for all guards
- Structural distinction between similar output shapes
- Extendable: when new guards or classifiers are added, their mutual exclusion tests go here

## Examples

- `isOutputTextDeltaEvent` returns true for text delta, false for reasoning delta
- `isOutputMessage` rejects a `TextDeltaEvent` (wrong domain)
- Regular tool satisfies `isRegularExecuteTool` but NOT `isGeneratorTool`
- `isToolPreliminaryResultEvent` rejects `{ type: 'tool.result' }`
- `createUnsentResult` shape vs `createRejectedResult` shape

## What does NOT belong here

- Testing what a guard does with valid input in detail (→ `behavior/`)
- Testing that guard output feeds a transformer (→ `composition/` or `dispatch/`)
- End-to-end type-guard-driven pipelines (→ `pipelines/`)
