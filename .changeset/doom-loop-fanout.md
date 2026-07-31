---
'@openrouter/agent': minor
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
direct/port callers — are scored per call against the previous round rather than
as a set. A repeating multi-call round there still accumulates, but only on
whichever call is recorded *last*, so the verdict lands on one member and which
member depends on emission order. Declare the round (see below) for
order-independent, whole-round scoring.

A call that a round's declaration could not include (unhashable key material)
is likewise scored on its own, and cannot move the round's counters — one
unhashable argument costs detection for its own call only, never for the tool.

**Resumed runs**: a *multi-call* round's streak now restarts after a
save/resume. The persisted shape carries one fingerprint per tool and cannot
express which set earned a count, so keeping it would attach a fan-out's
evidence to whichever member was recorded last — a resumed round of just that
one call would then be refused on its first appearance, despite the model doing
less work than before the save. A repeating fan-out is re-detected from a clean
baseline instead (observe at the second repeat after resume). Single-call
streaks still continue across a resume exactly as before.

**New API**: `DoomLoopMonitor.declareRound(round, calls)` — declares a round's
complete call set before any of it is scored. `DoomLoopMonitor` is exported, so
this is a new public method, additive only. Callers using `callModel` need not
touch it (the engine calls it); direct `DoomLoopMonitor` users and SDK ports
should, since an undeclared multi-call round falls back to per-call scoring and
its fan-out goes undetected.

Single-call round timing, in-round duplicate collapsing, persisted state
*shape*, verdict payloads, and the number of times a tool's `loopKey` is invoked
(once per checked call) are unchanged.

Known limit, unchanged by this fix: a call that repeats inside a round whose
other members keep varying (`[a,b]`, `[a,c]`, `[a,d]`) does not accumulate,
since round identity requires the whole set to match.

**Newly reachable false positive.** The detector compares arguments, not
results, so a tool invoked with a stable *set* of parallel arguments every round
now accumulates a streak where it previously could not — an agent re-reading the
same context files each turn, or a fixed fan-out of pollers, is refused at the
default `block` rung from round 3, with one synthesized error per call in the
round. Exempt such tools with `loopKey: false` (or a `loopKey` returning `null`
for the call). This class was invisible to the detector before, so no existing
exemption covered it.

For `callModel` users, nothing to change — `doomLoop` is configured exactly as
before, and the engine declares each round for you. What changed is when it
fires:

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

Driving `DoomLoopMonitor` directly (or porting it) is the case that needs the
new call — declare a round's whole batch before recording any of it.
`resolveDoomLoopOption` and `ResolvedDoomLoopConfig` are now exported too:
`DoomLoopMonitor` was previously exported without its config resolver, so it
could not actually be constructed from the public API.

```ts
import { DoomLoopMonitor, resolveDoomLoopOption } from '@openrouter/agent';

const monitor = new DoomLoopMonitor(resolveDoomLoopOption(true));

for (const [round, batch] of batches.entries()) {
  // NEW: declare the round's complete set BEFORE recording any of its calls.
  // Without this a multi-call round is scored per call, so a repeating fan-out
  // accumulates only on whichever call is recorded last — and which one that
  // is depends on emission order.
  await monitor.declareRound(
    round,
    batch.map((call) => ({ toolName: call.name, keyMaterial: call.arguments })),
  );

  for (const call of batch) {
    const { verdict } = await monitor.recordToolCall(call.name, call.arguments, round);
    if (verdict?.action === 'block') refuse(call, verdict.message);
  }
}
```
