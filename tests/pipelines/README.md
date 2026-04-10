# Pipelines Tests

Tests in this folder are **end-to-end agent workflows** where multiple capabilities compose, and at each layer we verify: what it specifically produces, how it differs from peers, and how it feeds the next layer.

These are the most comprehensive tests in the suite. Each test exercises a complete pipeline and makes assertions at every stage.

## What belongs here

- Full streaming pipeline: raw events -> guards -> transformers -> consumer
- Full tool execution pipeline: definition -> dispatch -> validate -> execute -> format
- Context pipeline: build -> resolve -> store -> execute
- Stop condition pipeline: results -> steps -> conditions -> decision
- Dual-format output: same response -> structurally distinct formats simultaneously
- Claude conversion deep pipeline: multi-item response -> per-item guard routing -> distinct blocks
- Bidirectional format conversion round-trips
- Extendable: when new end-to-end workflows are introduced, their full-pipeline tests with per-layer verification go here

## Examples

- Mixed stream events flow through type guards, extractors yield correct types, consumer receives via ReusableReadableStream
- `tool()` creates tool -> `executeTool` dispatches via guard -> validates input -> executes -> validates output -> formats for model
- Three concurrent stream consumers (`buildMessageStream`, `buildResponsesMessageStream`, `buildItemsStream`) all complete, each structurally different, no consumer blocks another

## What does NOT belong here

- Single-module behavior (-> `behavior/`)
- Two-module composition without per-layer verification (-> `composition/` or `integration/`)
- Tests that don't verify behavior, boundaries, and composition together (-> appropriate simpler category)
