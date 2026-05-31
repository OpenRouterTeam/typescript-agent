---
'@openrouter/agent': patch
---

fix: persist user input items to state.messages across callModel invocations

User input items (role: 'user') were never written to state.messages. The two
existing saveStateSafely write sites only persist response.output and
toolResults. When a new callModel resumes from persisted state, the loaded
state.messages contains zero user items — prior user turns are silently dropped.

This causes two problems:
1. cache_control prompt caching is defeated at every user-message boundary
2. Conversation fidelity loss — the model never sees prior user turns
