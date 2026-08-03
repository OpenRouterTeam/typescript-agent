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
