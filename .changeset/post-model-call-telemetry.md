---
'@openrouter/agent': minor
---

Add a `PostModelCall` lifecycle hook and aggregate usage totals on `SessionEnd` — the telemetry primitives for tracing and benchmark consumers.

`PostModelCall` fires once per completed model response, on **every** request the agent loop makes: the initial request, each tool-round follow-up, the empty-final retry, the `allowFinalResponse` final turn, and approval-resume requests. The payload carries `responseId` (the OpenRouter generation id, deep-linkable), `model`, `durationMs` (dispatch to fully materialized response, including stream consumption), `turnType` (`'initial' | 'resume' | 'tool_round' | 'final' | 'retry'`), `turnNumber`, and a normalized `usage` block (`inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, `cost?`) when the server reported usage accounting. Purely observational: handlers cannot mutate or block.

`SessionEnd` now carries an optional `totalUsage` aggregate (`modelCalls` plus the summed usage fields, with `cost` present when any call reported one) whenever at least one model call completed during the run.

New exported types: `PostModelCallPayload`, `ModelCallUsage`, `SessionUsageTotals`.
