---
'@openrouter/agent': patch
---

Refuse to execute a tool-call batch in which two `function_call` items share a `call_id`. Previously both calls ran and the follow-up request carried two `function_call_output` items for the same id, so the model could not tell which result answered which call. The run now rejects before any tool body runs or any follow-up request is sent, with an error naming the repeated id. Batches made only of manual tools (`execute: false`) are unchanged: the SDK runs nothing for them and the caller still receives every call as emitted.
