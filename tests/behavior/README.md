# Behavior Tests

Tests in this folder verify that each SDK capability works as promised **in isolation**. No comparison to similar capabilities, no cross-module composition — just: does this function do what its contract says?

## What belongs here

- Happy-path execution of individual functions
- Error cases and edge cases for a single function
- Return shape and type verification
- Input validation (valid and invalid)
- Default values and optional parameter handling
- Extendable: when new SDK capabilities are added, their isolated behavior tests go here

## Examples

- `tool()` factory produces the correct structure for each tool type
- `validateToolInput` accepts valid data and rejects invalid data
- `ReusableReadableStream` delivers items in order to a single consumer
- `createInitialState()` returns the expected shape with timestamps
- `resolveContext` handles static objects, functions, async functions, and undefined

## What does NOT belong here

- Tests comparing two similar functions (→ `boundaries/`)
- Tests where one module's output feeds another's input (→ `composition/`)
- End-to-end workflows (→ `pipelines/`)
