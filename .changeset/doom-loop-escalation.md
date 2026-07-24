---
'@openrouter/agent': minor
---

Doom-loop escalation recovery: a new `escalate` ladder rung between `steer` and `block` that unblocks a stuck run by throwing more intelligence at the next turn instead of refusing or halting.

Configure via `doomLoop.escalation`: `model` runs the NEXT turn on a stronger model (one-turn override, automatic revert), and/or `advisor` forces an `openrouter:advisor` consult (the advisor server tool is appended with `forwardTranscript: true` and loop-diagnosing instructions, and `toolChoice` is pinned to it via `allowed_tools`/`required` so the stuck model must ask for guidance first; an object form passes through as advisor parameters). A user notice naming the detected loop accompanies the escalated turn.

Escalations are real spend on a run already suspected of wasting it, so they are budgeted: `maxEscalations` (default 2) caps recoveries per conversation, budget is consumed when a recovery is *applied* (not at verdict time), `escalationsUsed` persists in `ConversationState.doomLoop` so resumes cannot reset it, and concurrent detector verdicts in one window escalate once. Exhausted or unconfigured escalations fall through to the weaker rungs; resolve-time warnings flag an `escalate` rung without a mechanism (and vice versa). The `DoomLoopDetected` hook's `action`/`overrideAction` enums gain `'escalate'` — an override without config/budget downgrades to `observe`, never silently to a stronger action.
