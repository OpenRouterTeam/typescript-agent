---
'@openrouter/agent': patch
---

`allowFinalResponse: true` now appends a built-in final-answer directive (exported as `DEFAULT_FINAL_RESPONSE_DIRECTIVE`) as the final user message on the forced no-tools turn. Previously bare `true` stripped tools but gave the model no signal that this was its last turn, so models that emit tool-call syntax as text (e.g. GLM) would attempt another tool call and leak unparsed `<tool_call>…` text into the final content (DEV-658).

```ts
callModel(client, {
  model: 'z-ai/glm-5.2',
  input: 'Research this step by step.',
  tools: [searchTool],
  stopWhen: stepCountIs(3),
  allowFinalResponse: true,
  // was: final turn sent with tools stripped and NO directive — GLM-style
  //      models could leak raw `<tool_call>…` text as the final answer
  // now: appends DEFAULT_FINAL_RESPONSE_DIRECTIVE as a final user message

  // custom wording still overrides the default:
  // allowFinalResponse: 'Summarize what you found.',
  // legacy no-message behavior remains available as an explicit opt-out:
  // allowFinalResponse: '',
});
```
