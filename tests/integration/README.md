# Integration Tests

Tests in this folder verify that a capability **works as specified AND composes correctly with another module**. Both the output correctness and the cross-module data flow are asserted.

## What belongs here

- A function produces the correct output AND that output successfully feeds the next module
- Stop conditions evaluated against real `StepResult` shapes from the orchestrator
- Context store data flowing through `buildToolExecuteContext` into a tool's `execute` function
- Stream consumers at different speeds both getting complete, correct data
- Next-turn param computation feeding into request modification with verified results
- Extendable: when new cross-module flows are introduced, their correctness-through-composition tests go here

## Examples

- `consumeStreamForCompletion` returns the response because `isResponseCompletedEvent` identified it
- `stepCountIs` works with `StepResult[]` containing real `usage` and `toolCalls` data
- Tool's `execute` receives context where `local` reflects store data set before execution
- Two `ReusableReadableStream` consumers at different read speeds both get all items correctly
- `executeNextTurnParamsFunctions` computes temperature -> `applyNextTurnParamsToRequest` produces correct request

## What does NOT belong here

- Pure specification without cross-module flow (→ `behavior/`)
- Pure composition without output verification (→ `composition/`)
- Boundary checks at composition points (→ `dispatch/`)
