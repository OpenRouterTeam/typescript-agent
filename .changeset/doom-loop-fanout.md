---
'@openrouter/agent': patch
---

Fix doom-loop detection missing a repeated same-tool fan-out.

Streaks compared a tool's *last* fingerprint, so `read(a), read(b), read(c)`
reissued verbatim had a different last call every round and each round's first
call reset the streak to 1. Eight identical rounds of a three-call fan-out
produced zero detections, while single-call rounds tripped at round 2 — and
distinct-argument fan-out is the dominant shape in parallel-tool-calling agents.

A round's identity for one tool is now the *set* of fingerprints it was called
with, compared across rounds. The engine declares a round's complete set before
any of its calls is scored, so ordering within the round does not matter, a
changed member resets the streak, and neither a strict subset nor a superset is
a repeat — a round that adds new work is progress, not repetition. Every call in
a repeating round reports that round's streak, so at the block rung a repeating
fan-out stops spending rather than only its last call being refused.

Paths that cannot know a round's membership up front — server-tool records, and
direct/port callers — are scored per call against the previous round, the same
as before this change: a fan-out there goes undetected rather than mis-scored.
A call that a round's declaration could not include (unhashable key material)
is likewise scored on its own, and cannot move the round's counters — one
unhashable argument costs detection for its own call only, never for the tool.

Single-call rounds, in-round duplicate collapsing, resumed streaks, persisted
state shape, verdict payloads, and the number of times a tool's `loopKey` is
invoked (once per call) are unchanged.

Known limit, unchanged by this fix: a call that repeats inside a round whose
other members keep varying (`[a,b]`, `[a,c]`, `[a,d]`) does not accumulate,
since round identity requires the whole set to match.

No API surface changed — `doomLoop` is configured exactly as before. What
changed is when it fires:

```ts
import { callModel } from '@openrouter/agent';

const result = callModel(client, {
  model: 'z-ai/glm-5.2',
  input: 'Summarize these files.',
  tools: [readTool],
  // Unchanged config; the ladder default is observe@2, block@3, stop@6.
  doomLoop: true,
});

// Say the model reissues the SAME three-call fan-out every round:
//   round 1: read(a), read(b), read(c)
//   round 2: read(a), read(b), read(c)   <- identical set
//
// was: no detection, ever. Each round's first call reset the streak, so
//      a fan-out could spin indefinitely while single calls tripped at
//      round 2.
// now: round 2 is streak 2 (observe), round 3 is streak 3 (block) — and
//      EVERY call of the round is refused at the block rung, not just one,
//      so the fan-out stops spending.
//
// A round that ADDS work is progress and resets to 1:
//   round 3: read(a), read(b), read(c), read(d)   <- no verdict
//
// `loopKey` still runs exactly once per checked call, and persisted
// `ConversationState.doomLoop` is byte-identical to before.
```
