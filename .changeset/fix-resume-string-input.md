---
"@openrouter/agent": patch
---

Fix: bare string `input` is now normalized into a message item when resuming a conversation with loaded history. Previously the raw string was appended to the request input array un-normalized, causing an OpenResponses 400 validation error on the advertised string-input style.
