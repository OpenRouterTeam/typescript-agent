---
"@openrouter/agent": minor
---

Add `allowFinalResponse` option to `callModel`, sibling of `stopWhen`. When the agent loop is halted by `stopWhen` while the last model response still contains tool calls, the pending tool calls are executed (so they have matching outputs) and one more model request is made with no tools so the loop ends with a natural-language summary instead of an unfinished tool call. Passing a string instead of `true` additionally appends that string as a final `user` message (e.g. `allowFinalResponse: 'Please summarize what you found.'`). The full accumulated input array and the original `instructions` are sent.
