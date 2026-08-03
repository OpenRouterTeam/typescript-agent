# Agent memory benchmark

This benchmark measures `@openrouter/agent` memory pressure with Cloudflare Workers' 128 MiB
per-isolate limit as the budget.

It uses two complementary workloads:

- Deterministic synthetic streams isolate `ReusableReadableStream` buffering and cumulative item
  streaming.
- Live OpenRouter calls measure short sequential requests, intentionally retained `ModelResult`
  objects, concurrent requests, output-size scaling, and a tool loop.

The live workload is bundled and tree-shaken as an ES module before it is loaded. This is closer to
a deployed Worker than importing the unbundled package directly in Node.

## Metrics

Each sample includes:

- `heapUsed`: live V8 heap.
- `external`: memory held by native objects associated with JavaScript objects.
- `tracked`: `heapUsed + external`, used as a conservative lower-bound comparison with 128 MiB.
- `rss`: the whole Node process; reported for diagnostics but not compared with a Worker isolate.

`arrayBuffers` is reported separately but is already included in `external`, so it is not added to
`tracked`.

Settled samples force two garbage collections. Peak samples poll every 2 ms by default. A sampled
peak can miss shorter allocation spikes, and Node's runtime overhead is not identical to workerd's,
so production confirmation should use the Cloudflare Workers Memory Usage metric.

## Run

Build the deterministic stream benchmark:

```bash
pnpm benchmark:memory:synthetic
```

Record raw, gzip, and Brotli sizes for the explicitly tree-shaken, minified
agent and SDK-only Worker bundles:

```bash
pnpm benchmark:memory:bundle-sizes
```

Run randomized fresh-process import measurements (20 runs per case by default):

```bash
pnpm benchmark:memory:imports
```

Compare full replay with active-consumer retention across 20 randomized fresh
processes and 50,000 events:

```bash
pnpm benchmark:memory:broadcaster
```

Run the complete live benchmark:

```bash
export OPENROUTER_TEST_KEY=...
pnpm benchmark:memory:live
```

The commands write JSON to stdout and never include the API key.

Useful focused runs:

```bash
# Long-run retained-growth comparison
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode live \
  --bundle .turbo/agent-memory/cloudflare-worker.bundle.mjs \
  --sections sequential,sdk-control \
  --iterations 50 \
  --warmups 5

# Concurrent long generations in one isolate
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode live \
  --bundle .turbo/agent-memory/cloudflare-worker.bundle.mjs \
  --sections concurrency \
  --concurrency-levels 16,32,64 \
  --concurrency-output-words 1024

# Growing multi-turn conversation with long outputs and per-turn token usage
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode live \
  --bundle .turbo/agent-memory/cloudflare-worker.bundle.mjs \
  --model openai/gpt-5.6-luna \
  --sections multi-turn-long \
  --multi-turn-count 4 \
  --multi-turn-output-words 2048

# The same multi-turn workload using only non-streaming fetch (no agent or SDK import)
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode raw-fetch \
  --model openai/gpt-5.6-luna \
  --multi-turn-count 4 \
  --multi-turn-output-words 2048

# The same streaming workload using the client SDK without the agent
pnpm benchmark:memory:sdk-bundle
node --expose-gc --max-old-space-size=128 --max-semi-space-size=8 \
  benchmarks/agent-memory/benchmark.mjs \
  --mode sdk-live \
  --bundle .turbo/agent-memory/cloudflare-sdk-worker.bundle.mjs \
  --model openai/gpt-5.6-luna \
  --multi-turn-count 4 \
  --multi-turn-output-words 2048
```

The Node heap flags create a constrained V8 process for earlier failure detection. They do not
exactly reproduce Cloudflare's accounting because the Workers limit includes isolate runtime and
WebAssembly memory, not only V8 old space.

Raw fetch mode is a lower-bound control: unlike the agent path, it requests one non-streaming JSON
response and therefore does not retain parsed server-sent events for replay.

SDK live mode streams through `@openrouter/sdk` but does not import or execute
`@openrouter/agent`. It isolates the generated client's schema and SSE parsing overhead from the
agent's replay and orchestration layers.
