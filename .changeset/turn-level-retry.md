---
'@openrouter/agent': minor
---

Add turn-level retry and hang detection to the callModel tool loop, plus a tool-level retry helper.

**`retryTurn` option on `callModel`** — when a turn (one provider request + stream consumption) fails, the turn is re-sent with the full accumulated conversation intact instead of aborting the whole loop. Tool results gathered in prior turns are never discarded and tools are not re-executed. Covers all turn sites: the initial request (send and consume phases), follow-up requests after tool execution, the forced final response, and state resume.

- `limit` — max retries per turn (default 2)
- `idleTimeoutMs` — converts silently-hung streams (no events, no terminal frame, connection left open) into retryable `TurnIdleTimeoutError` failures; the hung connection is cancelled
- `isRetryable` — custom retryability policy; the default (`defaultIsTurnRetryable`) retries idle timeouts, streams that ended without a terminal event, network errors, and HTTP 408/429/5xx, and does not retry `response.failed` terminal events (e.g. refusals) or other 4xx
- `backoffMs` — fixed or per-attempt delay between retries

Mid-turn retries emit a new `turn.retry` event on `getFullResponsesStream()` (`isTurnRetryEvent` guard exported); events already received for that turn should be treated as void since the retried attempt re-streams the turn from the start. Failure classification is now typed: `TurnIdleTimeoutError`, `TurnStreamEndedError`, `TurnResponseFailedError` (messages unchanged).

**`withToolRetry(tool, options)`** — wrap a tool so its `execute` function is automatically re-run when it throws (transient network failures inside tools no longer burn a model round trip). Supports regular and generator tools, preserves tool typing and type-guard classification, with `limit`, `backoffMs`, `isRetryable`, and `onRetry` observability hook. Only wrap idempotent tools.
