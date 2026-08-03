---
'@openrouter/agent': minor
---

Reduce multi-turn streaming memory with a single unified journal, release completed transport references, and add an opt-in `streamReplay: 'active-consumers'` mode that bounds tool-stream history while preserving full replay by default.

```ts
const result = client.callModel({
  model: 'openai/gpt-5.6-luna',
  input: 'Use the tools and stream the answer.',
  tools,
  // Default is "full"; use this when all stream consumers attach up front.
  streamReplay: 'active-consumers',
});
```
