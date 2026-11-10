---
'@openrouter/agent': patch
---

Give a stream consumer that attaches after the tool loop ran every turn of the run.

The turn broadcaster was created only when a stream method such as `getFullResponsesStream()` was first called. When another consumer (`getResponse()`, `getText()`, `getContextUpdates()`) had already driven the tool loop to the end, no broadcaster existed while the follow-up turns ran, so a stream consumer that attached afterwards received turn 0 only, and with `streamReplay: 'active-consumers'` it received no response events at all. The tool loop now starts the turn 0 pipe before it runs when the request has tools, so the broadcaster holds every turn for a late consumer.

A run with tools that never attaches a stream consumer now keeps its follow-up turn events in the broadcaster until the result is released.
