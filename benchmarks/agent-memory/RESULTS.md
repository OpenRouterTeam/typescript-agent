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

Run:

```bash
pnpm benchmark:memory:broadcaster
```

## Tree-shaken bundles

Every bundle uses esbuild 0.28.1 with ESM output, browser platform, ES2022
target, minification, and explicit `treeShaking: true`.

- Agent Worker: 508,573 raw / 111,310 gzip / 93,850 Brotli bytes.
- SDK-only Worker: 217,945 raw / 55,301 gzip / 47,257 Brotli bytes.

Twenty-run randomized fresh-import medians were 42,208,756 tracked bytes for
the agent bundle and 40,487,076 bytes for the SDK-only bundle.
