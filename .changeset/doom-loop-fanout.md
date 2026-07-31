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

**Per-call streaks** accumulate alongside the round-set streak, and the
stronger evidence decides. Each `(tool, arguments)` identity counts its own
consecutive rounds, whatever its round-mates did — so a call repeating inside
varying company (`[a,b]`, `[a,c]`, `[a,d]`: `a` is a 3-peat) is flagged even
though every round's set differs, a repeat keeps counting when a paused HITL
member drops from the resumed round, and undeclared paths (server-tool records,
direct callers) get order-independent per-call detection without a declaration.
When the per-call count alone crosses a rung, only that call is refused and its
verdict quotes its own identity; genuinely new round-mates run free. For an
exactly-repeating round both counts are equal, so nothing double-fires. A
partial repeat (`[a,b,c]` then `[a,b]`) flags the re-issued calls at the
observe rung rather than being invisible; a superset round (`[a,b]`, `[a,b]`,
`[a,b,c]`) flags the repeated members while the new call always executes.

A call that a round's declaration could not include (unhashable key material)
cannot inherit or move the round's counters; its own verbatim repetition still
accumulates per-call evidence like any other repeat.

**Resumed runs**: a multi-call round's fingerprint set and per-call counts are
persisted alongside its streak (new optional `roundFingerprints` and
`callStreaks` on `DoomLoopStreak` — additive; pre-existing blobs restore with
their old single-call semantics). A repeating
fan-out therefore keeps its evidence across save/resume boundaries: approval
pauses no longer reset a fan-out sitting at the block rung, and per-turn-resume
topologies (one `callModel` per user turn, state persisted between) accumulate
across turns instead of re-baselining on every one. Because the streak travels
with the exact set that earned it, a resumed round containing only a subset of
that set is a different round and starts at 1 — a lesser call can never inherit
a fan-out's evidence. Single-call streaks behave exactly as before.

**New API**: `DoomLoopMonitor.declareRound(round, calls)` — declares a round's
complete call set before any of it is scored. `DoomLoopMonitor` is exported, so
this is a new public method, additive only. Callers using `callModel` need not
touch it (the engine calls it); direct `DoomLoopMonitor` users and SDK ports
should, so a repeating fan-out is flagged as one unit (shared verdict, shared
steer message) rather than only via each member's individual per-call count.

Single-call round timing, in-round duplicate collapsing, verdict payloads, and
the number of times a tool's `loopKey` is invoked (once per checked call) are
unchanged. The persisted shape gains two optional fields (`roundFingerprints`
and `callStreaks`, both above); everything existing is untouched and old blobs
restore cleanly with their old semantics.

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
// A round that ADDS work resets the ROUND streak, but each repeated call
// keeps its own count — the model re-read a, b, c a third time:
//   round 3: read(a), read(b), read(c), read(d)
//            -> a, b, c blocked (3rd consecutive round each); d executes.
//
// `loopKey` still runs exactly once per checked call. Persisted state gains
// two optional fields so fan-out and per-call evidence survive save/resume;
// old state restores cleanly.
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
  // NEW: declare the round's complete set BEFORE recording any of its calls,
  // so a repeating fan-out is scored as one unit. (Per-call repetition is
  // detected either way; the declaration adds whole-round identity.)
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
