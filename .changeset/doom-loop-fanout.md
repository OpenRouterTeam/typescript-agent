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
