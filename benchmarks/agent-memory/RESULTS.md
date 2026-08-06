# Agent memory characterization

Measured on macOS arm64 with Node 24.18.0. Memory comparisons randomize
baseline/candidate order and use 20 fresh processes per case.

## Active-consumer replay

`streamReplay: 'active-consumers'` releases unified tool-stream events after
every attached consumer advances past them. The default `full` mode retains
history for consumers that attach later.

| Events | Full median peak | Active median peak | Reduction |
| ---: | ---: | ---: | ---: |
| 10,000 | 5,045,040 bytes | 944,336 bytes | 81.3% |
| 50,000 | 19,419,528 bytes | 2,704,120 bytes | 86.1% |
| 100,000 | 46,017,784 bytes | 5,609,216 bytes | 87.8% |

At 50,000 events, full replay's p95 peak was 22,412,576 bytes and
active-consumer replay's p95 was 2,710,776 bytes. Post-completion retained
memory was equivalent after forced garbage collection.

The standalone reusable stream used by no-tool runs was also measured across
20 randomized fresh processes at 50,000 events:

- Full replay median/p95 peak: 30,290,511 / 30,618,759 bytes.
- Active-consumer median/p95 peak: 3,717,872 / 4,258,503 bytes.
- Median peak reduction: 87.7%.

Run:

```bash
pnpm benchmark:memory:broadcaster
pnpm benchmark:memory:reusable
```

## Tree-shaken bundles

Every bundle uses esbuild 0.28.1 with ESM output, browser platform, ES2022
target, minification, and explicit `treeShaking: true`.

- Agent Worker: 510,095 raw / 111,581 gzip / 94,108 Brotli bytes.
- SDK-only Worker: 217,945 raw / 55,301 gzip / 47,257 Brotli bytes.

Twenty-run randomized fresh-import medians were 42,210,052 tracked bytes for
the agent bundle and 40,498,156 bytes for the SDK-only bundle.

## Fifty-request live retained growth

Each path ran 5 warmups followed by 50 sequential
`openai/gpt-5.6-luna` requests. The process forced garbage collection after
every request. This is one live sequence per path, not a 20-run confidence
sample.

- Raw non-streaming fetch: +0.738 MiB at run 50; 7.61 KiB/request overall.
- SDK streaming control: +1.307 MiB; 14.52 KiB/request.
- Agent streaming: +1.397 MiB; 15.27 KiB/request.

At run 50, the agent was about 92 KiB above the SDK control. The SDK path was
about 583 KiB above raw fetch, though raw used non-streaming JSON while SDK and
agent used SSE.

## Twenty-run live peak profiles

Each profile ran in 20 fresh processes in randomized order with four processes
in flight. Every tool case was required to execute exactly 10 sequential tool
turns followed by one final model turn.

No tools, 2,080 output-token cap:

- Absolute tracked peak median/p95: 58,192,392 / 61,156,651 bytes
  (55.497 / 58.324 MiB).
- Peak above each process's warmed baseline median/p95: 4,304,085 /
  7,270,736 bytes.
- Stream event count median/p95: 714 / 1,141.

Ten sequential tool turns plus a 2,112-token final turn:

- Absolute tracked peak median/p95: 62,374,974 / 63,672,240 bytes
  (59.485 / 60.723 MiB).
- Peak above warmed baseline median/p95: 8,332,084 / 9,666,181 bytes.
- Unified stream event count median/p95: 1,647 / 1,934.

These are live OpenRouter results and include model/provider event-count
variation. `tracked` is `heapUsed + external`, not Cloudflare's complete
isolate accounting.

## Other implementation ablations

Each result below also uses 20 randomized fresh processes.

### Single tool-stream journal

At 50,000 events, replacing the legacy reusable-stream plus broadcaster pair
with one journal changed:

- Median peak: 31,593,352 → 30,535,023 bytes (-3.3%).
- p95 peak: 32,039,048 → 30,645,615 bytes (-4.3%).
- Post-completion retained memory while the legacy replay object remained
  reachable: 15,496,338 → 1,058,882 bytes (-93.2%).

The peak improvement is real but small. The retained reduction is not a valid
drop-in performance claim: it comes from clearing history that the legacy
initial replay object kept available to later getters. Sequential getter
compatibility must be restored before this design can ship.

### Transport-reference cleanup

A real SDK 0.13.7 `EventStream` parsed 5,000 schema-validated text deltas in
each of 20 fresh processes while both variants retained the same replay
events:

- Median peak: 31,353,080 → 31,261,432 bytes (-0.3%, noise-sized).
- Median post-completion retained: 1,648,186 → 1,668,682 bytes (no saving).
- The SDK stream wrapper remained reachable in 20/20 legacy runs and became
  unreachable in 20/20 cleanup runs.

The cleanup improves object ownership and collectability, but it produced no
measurable memory reduction with a real completed SDK stream. The earlier
artificial 16 MiB attachment test was removed.

### Context-update queue

At the production characterization size of 100 queued updates:

- `Array.shift()` median drain time: 0.011 ms.
- Head-index median drain time: 0.004 ms.
- Peak memory was identical.

At an extreme 50,000-update backlog, drain time changed from 960.9 ms to
0.41 ms, but this is not representative of current web usage. The queue change
is defensive and has no material measured memory benefit.

Run:

```bash
pnpm benchmark:memory:single-journal
pnpm benchmark:memory:sdk-transport-cleanup
pnpm benchmark:memory:context-queue
```
