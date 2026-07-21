---
'@openrouter/agent': minor
---

Doom-loop detection for the tool-execution loop (opt-in via `doomLoop` on `callModel`).

Catches runs that stop making progress while continuing to spend: the model re-issuing the same tool call with identical arguments (including repeated empty `{}` calls and repeated invalid-JSON calls), or emitting the same text tokens over and over. Detection is deterministic — a verdict is a pure function of the transcript — and responds through a configurable graduated ladder: `observe` (emit the new `DoomLoopDetected` hook) → `steer` (inject corrective guidance) → `block` (refuse the call with an explanatory tool error, before execution) → `stop` (halt the loop; `SessionEnd.reason: 'doom_loop'`).

Tools declare what identifies a call via the new `loopKey` config field — a web-search tool hashes its normalized query, a bash tool hashes `{ command, cwd, ... }`, a status poller returns `null` to exempt itself; the engine owns canonicalization (recursive key sort) and fingerprinting, and defaults to the full arguments object when no `loopKey` is declared. Per-tool streaks survive interleaved calls to other tools, and detector state persists inside `ConversationState.doomLoop` so a resumed doom loop is still a doom loop. The `DoomLoopDetected` hook can override the action per event (`overrideAction`). New `@openrouter/agent/doom-loop` subpath exports the primitives (`DoomLoopMonitor`, `fingerprintToolCall`, `detectTextRepetition`, ...); `ModelResult.getDoomLoopVerdict()` reports a stopping verdict.
