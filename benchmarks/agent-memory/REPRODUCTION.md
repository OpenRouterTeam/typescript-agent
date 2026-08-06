# Cloudflare Worker agent memory reproduction

This document reproduces the retained-memory and peak-memory measurements for
raw `fetch`, `@openrouter/sdk`, and `@openrouter/agent`.

All request peaks are reported relative to the warmed, post-import,
forced-garbage-collection baseline immediately before that request. Bundle
memory is reported separately.

## Prerequisites

- macOS arm64 or Linux x64
- Node.js 24
- pnpm 10.22.0
- `OPENROUTER_TEST_KEY`

```bash
gh pr checkout 98 --repo OpenRouterTeam/typescript-agent
pnpm install --frozen-lockfile
export OPENROUTER_TEST_KEY=...
```

Never print or commit the key.

## Build the Worker-style bundle

The benchmark bundle is minified and explicitly tree-shaken for a browser
runtime.

```bash
pnpm benchmark:memory:bundle
pnpm benchmark:memory:bundle-sizes
```

The bundle-size report includes raw, gzip level 9, and Brotli quality 11 byte
counts and records `treeShaking: true`.

## Retained memory after each request

Each command performs five warmups, then 50 sequential
`openai/gpt-5.6-luna` requests. It forces garbage collection after every
request.

### Agent

```bash
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode live \
  --bundle .turbo/agent-memory/cloudflare-worker.bundle.mjs \
  --model openai/gpt-5.6-luna \
  --sections sequential \
  --iterations 50 \
  --warmups 5
```

Read:

- `measurements.live.sequential.finalDelta.tracked`
- `measurements.live.sequential.trackedSlopeBytesPerRequest`
- `measurements.live.sequential.settledSamples`

### Direct SDK control

```bash
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode live \
  --bundle .turbo/agent-memory/cloudflare-worker.bundle.mjs \
  --model openai/gpt-5.6-luna \
  --sections sdk-control \
  --iterations 50 \
  --warmups 5
```

Read `measurements.live.sdkControl`.

### Raw non-streaming fetch

```bash
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode raw-fetch \
  --model openai/gpt-5.6-luna \
  --sections sequential \
  --iterations 50 \
  --warmups 5
```

Read `measurements.rawFetch.sequential`.

## Peak memory

This command runs each profile in 20 fresh processes in randomized order. Four
processes run concurrently to reduce wall-clock time. Each child process has a
constrained V8 heap and one warmup request.

```bash
pnpm benchmark:memory:bundle

node benchmarks/agent-memory/run-live-peak-matrix.mjs \
  --runs=20 \
  --concurrency=4 \
  --cases=no-tools,tool-turns,fetch-tool-turns,fetch-stream-tool-turns
```

Profiles:

- `no-tools`: agent, 2,080 output-token cap.
- `tool-turns`: agent, 10 sequential local tools plus one final turn.
- `fetch-tool-turns`: equivalent manual loop using non-streaming JSON.
- `fetch-stream-tool-turns`: equivalent manual loop using an incremental
  SSE/JSON parser.

Every tool profile fails unless it executes exactly 10 tool calls and 11 model
requests. Read `peakAboveBaselineBytes`; `absolutePeakBytes` is diagnostic and
includes the loaded bundle.

## Current reference results

Measured on macOS arm64 with Node 24.18.0:

- Retained after 50 requests:
  - Raw fetch: +0.738 MiB.
  - Direct SDK: +1.307 MiB.
  - Agent: +1.397 MiB.
- No-tools agent peak above baseline, 20 runs:
  - Median: +4.105 MiB.
  - P95: +6.934 MiB.
- Ten-tool agent peak above baseline, 20 runs:
  - Median: +7.946 MiB.
  - P95: +9.218 MiB.
- Ten-tool raw streaming-fetch peak above baseline, 20 runs:
  - Median: +2.769 MiB.
  - P95: +2.983 MiB.
- Ten-tool raw non-streaming-fetch peak above baseline, 20 runs:
  - Median: +2.579 MiB.
  - P95: +2.869 MiB.

Model output text and event count vary between live runs. Each profile fixes
the model, output-token cap, tool count, tool order, and request count.

## Metric definition

`tracked` is:

```text
process.memoryUsage().heapUsed + process.memoryUsage().external
```

`arrayBuffers` is already included in `external` and is not added again.
Process RSS is not used as a Worker-isolate metric.

Node measurements are a controlled V8 proxy, not Cloudflare's authoritative
isolate accounting. Confirm a deployed candidate with the Workers Memory
Usage P50/P99/P999 metrics before promotion.
